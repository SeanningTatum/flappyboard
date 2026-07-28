import { Data } from "effect";

/**
 * A phone tried to pair (or to write with a grant) and the token did not hold
 * up. `reason` is for the server log only — the client is told "rescan" and
 * nothing more, because "expired" vs "bad-signature" vs "already used" is
 * exactly the feedback that makes a token oracle useful to an attacker.
 *
 * Maps to UNAUTHORIZED in `app/lib/effect-trpc.ts`. Note that it is only ever
 * raised where the caller has *already presented* something for this board, so
 * it cannot be used to distinguish a real board id from an invented one — see
 * `app/trpc/routes/board.ts` for the non-enumeration argument.
 */
export type PairingRefusal =
  | "malformed"
  | "bad-signature"
  | "expired"
  | "spent"
  | "missing";

export class PairingTokenInvalidError extends Data.TaggedError(
  "PairingTokenInvalidError"
)<{
  readonly boardId: string;
  readonly reason: PairingRefusal;
}> {}

/**
 * The board agent could not produce anything at all — the model call itself
 * failed (network, auth, rate limit), or it came back with no text to read.
 *
 * Deliberately *not* raised for a malformed board: a response that does not
 * decode is retried and then deterministically repaired (see
 * `app/services/board-agent.ts`), because the board must always end up with a
 * renderable grid. This error is only for "there is no response to work with".
 *
 * Maps to INTERNAL_SERVER_ERROR in `app/lib/effect-trpc.ts`.
 */
export class BoardGenerationError extends Data.TaggedError(
  "BoardGenerationError"
)<{
  /** Where in the pipeline it broke — for the log, not the client. */
  readonly stage: "request" | "empty";
  readonly cause: unknown;
}> {}

/**
 * The model's safety classifiers declined the prompt (`stop_reason: "refusal"`).
 * That is a property of what the *user asked for*, so it is a 400 and not a 500 —
 * rephrasing is the fix, retrying verbatim is not.
 *
 * `category` is the policy label the API reports (`cyber`, `bio`, …) and is for
 * the server log; the client is told to rephrase and nothing more.
 *
 * Maps to BAD_REQUEST in `app/lib/effect-trpc.ts`.
 */
export class LlmRefusedError extends Data.TaggedError("LlmRefusedError")<{
  readonly category: string | null;
}> {}

/**
 * Speech-to-text could not turn the phone's recording into usable text — the
 * clip was empty, too short, or the transcriber rejected it.
 *
 * Like `LlmRefusedError` this is a 400: the input is the problem, so the phone
 * should prompt the user to record again rather than surface a server fault.
 * Defined here (rather than in the voice feature) so the transcription service
 * has a typed error to fail with the moment it lands.
 *
 * Maps to BAD_REQUEST in `app/lib/effect-trpc.ts`.
 */
export class TranscriptionFailedError extends Data.TaggedError(
  "TranscriptionFailedError"
)<{
  /** Short, client-safe reason ("audio was empty", "unsupported format"). */
  readonly reason: string;
  readonly cause?: unknown;
}> {}

/**
 * The caller is over the spend cap on a metered endpoint — `board.generate`
 * (Anthropic) or `/api/transcribe` (Workers AI). Raised *before* the paid call
 * is made, which is the whole point.
 *
 * Unlike `PairingTokenInvalidError`, everything here is safe to tell the client:
 * both fields describe the caller's own usage of a board they are already
 * authorised for, so there is no oracle to leak. `retryAfter` is what lets the
 * phone say something better than "try again later".
 *
 * Maps to TOO_MANY_REQUESTS in `app/lib/effect-trpc.ts`.
 */
export class RateLimitError extends Data.TaggedError("RateLimitError")<{
  /** Which cap was hit — echoed to the client. */
  readonly endpoint: "generate" | "transcribe";
  /** Whole seconds until the window rolls over. Never 0. */
  readonly retryAfter: number;
}> {}

export type BoardError =
  | PairingTokenInvalidError
  | BoardGenerationError
  | LlmRefusedError
  | TranscriptionFailedError
  | RateLimitError;
