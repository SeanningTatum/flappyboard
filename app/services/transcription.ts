import { Context, Effect, Layer } from "effect";

import { CloudflareEnv } from "./cloudflare";
import {
  ConfigurationError,
  ExternalServiceError,
} from "@/models/errors/repository";
import { TranscriptionFailedError } from "@/models/errors/board";
import { bytesToBase64, normalizeTranscript } from "@/lib/board/voice";

/**
 * Speech → text on the `AI` binding. The first consumer of Workers AI in this
 * app: the binding has been declared in both wrangler environments since setup
 * and had no callers until walkie-talkie voice input.
 *
 * Shaped exactly like `BoardRoom`: a `Context.Tag`, a `Layer.effect` that reads
 * the binding off `CloudflareEnv` once at construction, and typed failures. The
 * split between the two failure channels is the design decision worth stating:
 *
 * - **`TranscriptionFailedError`** — the *recording* is the problem (no audio,
 *   nothing said). Its `reason` is echoed verbatim to the phone, so every one is
 *   written as a sentence a person standing in a living room can act on.
 * - **`ExternalServiceError`** — the *binding* is the problem (it threw, or it
 *   answered with something that is not a transcription). Server fault, logged
 *   with its cause, and the phone is told nothing beyond "try again".
 *
 * Conflating them would mean either leaking Cloudflare's internals into a toast
 * or telling a user to re-record when the model is down.
 */

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `@cf/openai/whisper-large-v3-turbo` over the two alternatives on the binding:
 *
 * - `@cf/openai/whisper-tiny-en` is **English-only**, and this app ships `en`
 *   and `zh` locales — a Chinese-speaking user would get transliterated noise.
 * - `@cf/openai/whisper` (the base model) takes `audio` as a `number[]` of raw
 *   bytes, which means JSON-serialising one integer per byte: ~4× the payload of
 *   base64 for the same clip, built by allocating an array a million elements
 *   long inside a Worker.
 *
 * `large-v3-turbo` is multilingual, takes base64 (`audio: string`), reports the
 * detected language, and is the distilled/fastest large variant — which is what
 * matters when someone is holding a button waiting for a TV to change.
 */
export const TRANSCRIPTION_MODEL = "@cf/openai/whisper-large-v3-turbo";

/**
 * Voice activity detection on. It drops leading/trailing silence before the
 * decoder sees it, which is both cheaper and materially less likely to produce
 * Whisper's classic hallucination-on-silence ("Thank you for watching!") — the
 * failure mode that would otherwise put a stranger's YouTube outro on a TV.
 */
export const TRANSCRIPTION_VAD_FILTER = true;

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

export interface TranscribeParams {
  /** The raw recording. Transient — never persisted anywhere. */
  readonly audio: Uint8Array;
  /**
   * BCP-47 hint from the caller's locale. Absent means "detect it", which is
   * the right default: the phone's UI language is not necessarily the language
   * the person speaks at their television.
   */
  readonly language?: string;
}

export interface TranscriptionResult {
  /** Normalised and non-empty — an empty transcript is a failure, not a value. */
  readonly transcript: string;
  readonly language: string | null;
  readonly durationSeconds: number | null;
}

export interface TranscriptionShape {
  readonly transcribe: (
    params: TranscribeParams
  ) => Effect.Effect<
    TranscriptionResult,
    TranscriptionFailedError | ExternalServiceError
  >;
}

export class Transcription extends Context.Tag("app/Transcription")<
  Transcription,
  TranscriptionShape
>() {}

/* -------------------------------------------------------------------------- */
/* Output parsing                                                             */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export interface RawTranscription {
  readonly text: string;
  readonly language: string | null;
  readonly durationSeconds: number | null;
}

/**
 * The binding's answer, narrowed. Same discipline as `parseRoomState`: the
 * generated `Ai` types describe what the model is *documented* to return, and a
 * `null` here (rather than an optimistic cast) is what turns a shape change into
 * a typed `ExternalServiceError` instead of `undefined` reaching the board.
 *
 * `text` present but empty is deliberately **not** rejected here — that is a
 * legitimate answer from the decoder ("I heard nothing"), and it is
 * `transcribe`'s job to turn it into the user-facing "I didn't catch that".
 */
export const parseTranscriptionOutput = (
  payload: unknown
): RawTranscription | null => {
  if (!isRecord(payload)) return null;
  if (typeof payload.text !== "string") return null;
  const info = isRecord(payload.transcription_info)
    ? payload.transcription_info
    : undefined;
  return {
    text: payload.text,
    language: typeof info?.language === "string" ? info.language : null,
    durationSeconds:
      typeof info?.duration === "number" && Number.isFinite(info.duration)
        ? info.duration
        : null,
  };
};

/* -------------------------------------------------------------------------- */
/* Implementation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The whole surface of the `AI` binding this service touches, as one function.
 * Narrow on purpose — the unit tests substitute a plain async function, so the
 * empty-audio guard, the empty-transcript guard, the output parsing and the
 * error mapping are all exercised with no network anywhere.
 */
export type TranscriptionClient = (input: {
  readonly audio: string;
  readonly language?: string;
  readonly vad_filter: boolean;
}) => Promise<unknown>;

/**
 * User-facing failure copy. These strings are echoed to the phone by
 * `/api/transcribe` (`TranscriptionFailedError.reason` maps to `BAD_REQUEST`
 * with its reason intact), so they are written for a person, not a log.
 */
export const EMPTY_AUDIO_REASON = "The recording was empty. Hold the button and speak.";
export const NO_SPEECH_REASON = "I didn't catch any words. Hold the button and speak.";

export const makeTranscription = (
  client: TranscriptionClient
): TranscriptionShape => ({
  transcribe: (params) =>
    Effect.gen(function* () {
      // Checked before anything is encoded or sent. A zero-byte body is a
      // client bug or a tap, and spending an inference call to be told so is
      // both slow and billed.
      if (params.audio.byteLength === 0) {
        return yield* Effect.fail(
          new TranscriptionFailedError({ reason: EMPTY_AUDIO_REASON })
        );
      }

      const payload = yield* Effect.tryPromise({
        try: () =>
          client({
            audio: bytesToBase64(params.audio),
            language: params.language,
            vad_filter: TRANSCRIPTION_VAD_FILTER,
          }),
        // The binding threw: model unavailable, account limit, malformed
        // request. Not the user's recording, so not their error.
        catch: (cause) =>
          new ExternalServiceError({ service: "Transcription", cause }),
      });

      const raw = parseTranscriptionOutput(payload);
      if (raw === null) {
        return yield* Effect.fail(
          new ExternalServiceError({
            service: "Transcription",
            cause: "the AI binding returned an unrecognised transcription payload",
          })
        );
      }

      const transcript = normalizeTranscript(raw.text);
      if (transcript.length === 0) {
        // Whisper heard nothing (or only silence that VAD stripped). Never
        // return "" — a caller that fed it to `board.generate` would spend a
        // Sonnet call to write a board about nothing.
        yield* Effect.logInfo("Transcription produced no words").pipe(
          Effect.annotateLogs({
            bytes: params.audio.byteLength,
            durationSeconds: raw.durationSeconds,
          })
        );
        return yield* Effect.fail(
          new TranscriptionFailedError({ reason: NO_SPEECH_REASON })
        );
      }

      return {
        transcript,
        language: raw.language,
        durationSeconds: raw.durationSeconds,
      };
    }),
});

/**
 * The binding is read once, when the Layer is built, and a missing one is a
 * typed `ConfigurationError` — not a `TypeError` on `undefined.run` three frames
 * deep. Mirrors `BoardRoomLive` / `BucketLive` exactly.
 *
 * This Layer is **not** in `app/runtime.ts`. Every member of a merged layer is
 * constructed when the runtime is built, so a Layer that can fail on a missing
 * binding would 500 every request in the app if `AI` were ever absent from a
 * deployment — the failure mode that got `Bucket` evicted from the global
 * runtime. `/api/transcribe` provides this per-request instead, the same way
 * `upload-file.ts` provides `BucketLive`, so an AI-less deploy breaks exactly
 * one button.
 */
export const TranscriptionLive = Layer.effect(
  Transcription,
  Effect.gen(function* () {
    const env = yield* CloudflareEnv;
    const ai = (env as Env & { AI?: Ai }).AI;
    if (!ai) {
      return yield* Effect.fail(
        new ConfigurationError({ service: "Transcription", field: "AI" })
      );
    }
    return makeTranscription((input) =>
      // The generated `Ai` types accept the documented input for this model; the
      // return is narrowed by `parseTranscriptionOutput` rather than trusted.
      ai.run(TRANSCRIPTION_MODEL, input) as Promise<unknown>
    );
  })
);
