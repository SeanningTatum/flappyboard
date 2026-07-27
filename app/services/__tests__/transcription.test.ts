import { describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";

import {
  EMPTY_AUDIO_REASON,
  NO_SPEECH_REASON,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_VAD_FILTER,
  Transcription,
  TranscriptionLive,
  makeTranscription,
  parseTranscriptionOutput,
  type TranscriptionClient,
} from "../transcription";
import { CloudflareEnvLive } from "../cloudflare";
import { TranscriptionFailedError } from "@/models/errors/board";
import {
  ConfigurationError,
  ExternalServiceError,
} from "@/models/errors/repository";
import { bytesToBase64 } from "@/lib/board/voice";

/* -------------------------------------------------------------------------- */
/* Stubs — no network anywhere in this file                                   */
/* -------------------------------------------------------------------------- */

const audio = new Uint8Array([1, 2, 3, 4, 5]);

interface Recorded {
  readonly calls: Array<Record<string, unknown>>;
}

/** Answers with `answer`, or rejects with it when it is an Error. */
const stubClient = (
  answer: unknown
): { client: TranscriptionClient; recorded: Recorded } => {
  const recorded: Recorded = { calls: [] };
  const client: TranscriptionClient = async (input) => {
    recorded.calls.push({ ...input });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { client, recorded };
};

const whisperReply = (
  text: string,
  info?: { language?: string; duration?: number }
) => ({
  text,
  transcription_info: info,
  word_count: text.split(" ").length,
});

/** A stubbed `AI` binding — `run` and nothing else, which is all the Layer uses. */
const fakeAi = (handler: (model: string, input: unknown) => unknown) =>
  ({ run: async (model: string, input: unknown) => handler(model, input) }) as unknown as Ai;

const envWith = (ai: unknown) =>
  CloudflareEnvLive({ BETTER_AUTH_SECRET: "test-secret", AI: ai } as unknown as Env);

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") throw new Error("expected a typed failure");
  return failure.value;
};

/* -------------------------------------------------------------------------- */
/* parseTranscriptionOutput                                                   */
/* -------------------------------------------------------------------------- */

describe("parseTranscriptionOutput", () => {
  it("reads text plus the optional language and duration", () => {
    expect(
      parseTranscriptionOutput(
        whisperReply("HELLO BOARD", { language: "en", duration: 2.5 })
      )
    ).toEqual({ text: "HELLO BOARD", language: "en", durationSeconds: 2.5 });
  });

  it("keeps text when transcription_info is missing entirely", () => {
    expect(parseTranscriptionOutput({ text: "hi" })).toEqual({
      text: "hi",
      language: null,
      durationSeconds: null,
    });
  });

  it("accepts an empty string — 'I heard nothing' is the decoder's answer, not a shape error", () => {
    expect(parseTranscriptionOutput({ text: "" })).toEqual({
      text: "",
      language: null,
      durationSeconds: null,
    });
  });

  it("rejects a payload with no text field", () => {
    expect(parseTranscriptionOutput({ transcription: "wrong key" })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseTranscriptionOutput(null)).toBeNull();
    expect(parseTranscriptionOutput("HELLO")).toBeNull();
    expect(parseTranscriptionOutput(undefined)).toBeNull();
  });

  it("drops a non-finite duration rather than propagating NaN", () => {
    expect(
      parseTranscriptionOutput(
        whisperReply("hi", { duration: Number.NaN })
      )?.durationSeconds
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* transcribe — the happy path                                                */
/* -------------------------------------------------------------------------- */

describe("makeTranscription", () => {
  it.effect("returns a normalised transcript", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient(
        whisperReply("  Put   dinner\non the board  ", {
          language: "en",
          duration: 3,
        })
      );
      const result = yield* makeTranscription(client).transcribe({ audio });

      expect(result).toEqual({
        transcript: "Put dinner on the board",
        language: "en",
        durationSeconds: 3,
      });
      expect(recorded.calls).toHaveLength(1);
    })
  );

  it.effect("sends base64 audio with VAD on, and the language hint when given", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient(whisperReply("hello"));
      yield* makeTranscription(client).transcribe({ audio, language: "zh" });

      expect(recorded.calls[0]).toEqual({
        audio: bytesToBase64(audio),
        language: "zh",
        vad_filter: TRANSCRIPTION_VAD_FILTER,
      });
    })
  );

  it.effect("caps a runaway transcript instead of passing it on whole", () =>
    Effect.gen(function* () {
      const { client } = stubClient(whisperReply("word ".repeat(400)));
      const result = yield* makeTranscription(client).transcribe({ audio });
      expect(result.transcript.length).toBe(400);
    })
  );

  /* ------------------------------------------------------------------------ */
  /* transcribe — the failure paths                                           */
  /* ------------------------------------------------------------------------ */

  it.effect("fails with a user-facing reason on empty audio, without calling the model", () =>
    Effect.gen(function* () {
      const { client, recorded } = stubClient(whisperReply("never reached"));
      const exit = yield* Effect.exit(
        makeTranscription(client).transcribe({ audio: new Uint8Array() })
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(TranscriptionFailedError);
      expect((error as TranscriptionFailedError).reason).toBe(EMPTY_AUDIO_REASON);
      // The whole point: no inference call was billed to learn this.
      expect(recorded.calls).toHaveLength(0);
    })
  );

  it.effect("fails with a user-facing reason on an empty transcript", () =>
    Effect.gen(function* () {
      const { client } = stubClient(whisperReply(""));
      const exit = yield* Effect.exit(
        makeTranscription(client).transcribe({ audio })
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(TranscriptionFailedError);
      expect((error as TranscriptionFailedError).reason).toBe(NO_SPEECH_REASON);
    })
  );

  it.effect("fails the same way on a whitespace-only transcript", () =>
    Effect.gen(function* () {
      const { client } = stubClient(whisperReply("  \n\t  "));
      const exit = yield* Effect.exit(
        makeTranscription(client).transcribe({ audio })
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(TranscriptionFailedError);
      expect((error as TranscriptionFailedError).reason).toBe(NO_SPEECH_REASON);
    })
  );

  it.effect("maps a thrown binding error to ExternalServiceError, not a user error", () =>
    Effect.gen(function* () {
      const boom = new Error("AI binding unavailable");
      const { client } = stubClient(boom);
      const exit = yield* Effect.exit(
        makeTranscription(client).transcribe({ audio })
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(ExternalServiceError);
      expect((error as ExternalServiceError).service).toBe("Transcription");
      expect((error as ExternalServiceError).cause).toBe(boom);
    })
  );

  it.effect("maps an unrecognised payload to ExternalServiceError", () =>
    Effect.gen(function* () {
      const { client } = stubClient({ unexpected: true });
      const exit = yield* Effect.exit(
        makeTranscription(client).transcribe({ audio })
      );
      expect(failureOf(exit)).toBeInstanceOf(ExternalServiceError);
    })
  );
});

/* -------------------------------------------------------------------------- */
/* Layer wiring                                                               */
/* -------------------------------------------------------------------------- */

describe("TranscriptionLive", () => {
  it.effect("calls the AI binding with the chosen Whisper model", () =>
    Effect.gen(function* () {
      const seen: Array<{ model: string; input: unknown }> = [];
      const ai = fakeAi((model, input) => {
        seen.push({ model, input });
        return whisperReply("BOARD SAYS HI");
      });

      const result = yield* Effect.gen(function* () {
        const service = yield* Transcription;
        return yield* service.transcribe({ audio });
      }).pipe(Effect.provide(TranscriptionLive.pipe(Layer.provide(envWith(ai)))));

      expect(result.transcript).toBe("BOARD SAYS HI");
      expect(seen[0]?.model).toBe(TRANSCRIPTION_MODEL);
    })
  );

  it.effect("fails construction with a typed ConfigurationError when AI is absent", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const service = yield* Transcription;
          return yield* service.transcribe({ audio });
        }).pipe(
          Effect.provide(TranscriptionLive.pipe(Layer.provide(envWith(undefined))))
        )
      );

      const error = failureOf(exit);
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).field).toBe("AI");
    })
  );
});
