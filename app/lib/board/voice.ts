import { Schema } from "effect";

/**
 * The pure half of walkie-talkie voice input — every decision about the audio
 * that does not need a binding, a browser or a network.
 *
 * It lives here rather than inside the button or the route because the limits
 * have to be **one** set of numbers: the phone stops recording at the cap, and
 * `/api/transcribe` refuses anything past it. Two copies of that ceiling is two
 * chances for the phone to record something the server will throw away. Same
 * argument as `app/lib/constants/upload.ts`, which pairs client `maxSize` with
 * the server's `MAX_UPLOAD_SIZE_BYTES`.
 */

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hard cap on one press, in milliseconds.
 *
 * 10s, because the thing being dictated is at most `BOARD_ROWS × BOARD_COLS` =
 * 144 characters of split-flap text. Ten seconds is roughly 25 spoken words —
 * already more than fits on the board — so a longer cap buys nothing but a
 * longer wait, a bigger upload and a bigger Whisper bill. The button stops
 * itself here rather than trusting the user to let go.
 */
export const MAX_RECORDING_MS = 10_000;

/**
 * A press shorter than this is a tap, not speech. Filtered on the client before
 * anything is uploaded — a 60ms blob is either a mis-touch or silence, and
 * either way the round trip is wasted.
 */
export const MIN_RECORDING_MS = 350;

/**
 * Ceiling on the uploaded body, in bytes.
 *
 * `MAX_RECORDING_MS` of Opus-in-WebM (what every browser that matters produces)
 * is ~40-80 KB at MediaRecorder's default bitrate. 1 MiB is therefore ~13× the
 * expected size — deliberately loose, because the point of this number is to
 * stop someone POSTing a 40MB podcast at a metered AI binding, not to
 * second-guess a codec. Uncompressed 16-bit mono WAV at 16kHz (what the test
 * script sends) is ~320 KB for 10s and still fits.
 */
export const MAX_AUDIO_BYTES = 1024 * 1024;

/**
 * Base content types the transcribe route accepts. Codec parameters are
 * stripped before the comparison (`audio/webm;codecs=opus` → `audio/webm`),
 * because that suffix is exactly what MediaRecorder emits and it varies by
 * browser and by platform.
 *
 * Everything here is a container Whisper's decoder understands. Note what is
 * absent: `video/webm`. Chrome will happily hand you one from
 * `MediaRecorder` if you ask for the wrong mime type, and it is not audio.
 */
export const ALLOWED_AUDIO_CONTENT_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/mp3",
  "audio/aac",
  "audio/x-m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
] as const;

export type AllowedAudioContentType =
  (typeof ALLOWED_AUDIO_CONTENT_TYPES)[number];

/** `audio/webm;codecs=opus` → `audio/webm`. Lowercased, trimmed, never throws. */
export const baseContentType = (value: string): string =>
  value.split(";")[0]!.trim().toLowerCase();

export const isAllowedAudioContentType = (value: string | null): boolean => {
  if (value === null) return false;
  return (ALLOWED_AUDIO_CONTENT_TYPES as readonly string[]).includes(
    baseContentType(value)
  );
};

/* -------------------------------------------------------------------------- */
/* Recorder mime selection                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Candidates in descending order of "small and universally decodable".
 *
 * Opus first: it is the best speech codec available in a browser and Safari 17+
 * finally records it. `audio/mp4` is the Safari fallback (AAC), and the bare
 * types cover a UA that reports support only without a codec parameter.
 */
export const RECORDER_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg",
] as const;

/**
 * The first candidate the platform admits to supporting, or `undefined` to let
 * `MediaRecorder` choose its own default.
 *
 * Takes the predicate rather than calling `MediaRecorder.isTypeSupported`
 * directly so this is testable in a Node test runner with no DOM — which is
 * also what makes it honest about the case where nothing matches.
 */
export const pickRecorderMimeType = (
  isSupported: (type: string) => boolean
): string | undefined => RECORDER_MIME_CANDIDATES.find(isSupported);

/* -------------------------------------------------------------------------- */
/* Transcript normalisation                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The transcript becomes an LLM prompt, so it is bounded. Generous relative to
 * `MAX_RECORDING_MS` (10s of speech is nowhere near 400 characters) — this
 * exists so a hallucinating decoder that emits a repeating loop cannot turn one
 * press into an unbounded prompt.
 */
export const MAX_TRANSCRIPT_CHARS = 400;

/**
 * Trim, collapse every run of whitespace (Whisper emits newlines and doubled
 * spaces around segment boundaries), then cap.
 *
 * Returns `""` for anything that was empty or whitespace-only — the caller is
 * expected to treat that as a failure rather than as a prompt, which is the
 * whole reason this returns a plain string instead of throwing: the decision of
 * *which* typed error an empty transcript deserves belongs to the service.
 */
export const normalizeTranscript = (raw: string): string =>
  raw.replace(/\s+/g, " ").trim().slice(0, MAX_TRANSCRIPT_CHARS);

/* -------------------------------------------------------------------------- */
/* Elapsed-time readout                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `M:SS` for the recording readout. Clamped at zero so a clock that jumps
 * backwards (a suspended tab resuming) renders `0:00` rather than `-1:59`.
 */
export const formatElapsed = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  return `${Math.floor(total / 60)}:${String(seconds).padStart(2, "0")}`;
};

/* -------------------------------------------------------------------------- */
/* The `/api/transcribe` wire contract                                        */
/* -------------------------------------------------------------------------- */

/** Effect Schema, not Zod — see the non-negotiables. */
export const TranscribeSuccessBody = Schema.Struct({
  transcript: Schema.String.pipe(Schema.minLength(1)),
});
export type TranscribeSuccessBody = typeof TranscribeSuccessBody.Type;

export const TranscribeErrorBody = Schema.Struct({
  error: Schema.String.pipe(Schema.minLength(1)),
});
export type TranscribeErrorBody = typeof TranscribeErrorBody.Type;

const decodeSuccess = Schema.decodeUnknownEither(TranscribeSuccessBody);
const decodeFailure = Schema.decodeUnknownEither(TranscribeErrorBody);

export type TranscribeOutcome =
  | { readonly ok: true; readonly transcript: string }
  /**
   * `reason` is the server's own user-facing string when it sent one (a
   * `TranscriptionFailedError`'s `reason`), and `null` when it did not — a 503,
   * an HTML error page from a proxy, a body that did not decode. `null` is the
   * signal for the caller to fall back to its own generic copy instead of
   * printing whatever bytes came back.
   */
  | { readonly ok: false; readonly reason: string | null };

/**
 * Read one `/api/transcribe` response. Pure: the fetch happens elsewhere, and a
 * non-2xx with a decodable `{ error }` is a *result*, not an exception.
 *
 * A 2xx whose body does not decode is a failure with no reason — the route
 * promises `{ transcript }` and a 200 carrying anything else means something
 * between here and there rewrote it.
 */
export const readTranscribeOutcome = (
  status: number,
  body: unknown
): TranscribeOutcome => {
  if (status >= 200 && status < 300) {
    const decoded = decodeSuccess(body);
    if (decoded._tag === "Right") {
      return { ok: true, transcript: decoded.right.transcript };
    }
    return { ok: false, reason: null };
  }
  const failed = decodeFailure(body);
  return { ok: false, reason: failed._tag === "Right" ? failed.right.error : null };
};

/* -------------------------------------------------------------------------- */
/* base64                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Standard base64 (padded, `+/` alphabet) — what the Whisper binding wants,
 * which is why this is not `bytesToBase64Url` from `pairing.ts`.
 *
 * Chunked, and that is the entire point: `String.fromCharCode(...bytes)` on a
 * `MAX_AUDIO_BYTES` array spreads a million arguments onto the stack and throws
 * `RangeError: Maximum call stack size exceeded`. 8KiB per call is comfortably
 * under every engine's argument limit.
 */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  const CHUNK = 0x2000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};
