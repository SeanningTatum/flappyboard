import { Either, Schema } from "effect";

/**
 * Spend caps for the two endpoints that cost real money — `board.generate`
 * (Anthropic, billed to the owner's `ANTHROPIC_API_KEY`) and `/api/transcribe`
 * (Workers AI Whisper, billed to the account's `AI` binding).
 *
 * Everything here is pure: the window arithmetic, the storage keys and the wire
 * shapes. The atomic check-and-increment that uses them lives in
 * `workers/board-room.ts`, for the same reason the spent-nonce ledger does — one
 * Durable Object per board is the only place where read → decide → write is
 * genuinely serialised.
 *
 * ## Why two buckets, not one
 *
 * Authorisation on both endpoints is correct and is checked before the body is
 * read, so this is not an auth hole: a legitimately paired phone is simply
 * unbounded. Photograph the TV, redeem the QR, and the resulting grant can loop
 * either endpoint until someone notices the bill.
 *
 * A **per-spender** bucket keyed by the grant's own nonce is what makes the cap
 * fair — one guest cannot eat another's allowance, and the owner's own budget is
 * separate from any guest's. But per-spender alone is bypassable by re-pairing:
 * every fresh QR redemption mints a fresh nonce and therefore a fresh allowance.
 * So a **per-board** bucket sits behind it as the hard ceiling, and a call has to
 * clear both. Re-pairing now buys nothing, and the blast radius of a photographed
 * board is bounded by the board, not by the attacker's patience.
 *
 * Both buckets are fixed windows rather than a sliding log: a window boundary
 * lets a determined caller burst up to 2× the limit across it, which is an
 * acceptable trade for two integers of storage instead of a timestamp list per
 * spender. The cap exists to bound a runaway bill, not to smooth traffic.
 */

/** The endpoints that are metered. Part of the storage key, so caps are separate. */
export const QUOTA_ENDPOINTS = ["generate", "transcribe"] as const;
export type QuotaEndpoint = (typeof QUOTA_ENDPOINTS)[number];

/**
 * Upper bound on a spender id written into a storage key. Ours are
 * `grant:<22-char nonce>` or `owner:<uuid>`; the ceiling is here so a caller can
 * never write an unbounded key into Durable Object storage — the same rule
 * `MAX_NONCE_LENGTH` enforces for the nonce ledger.
 */
export const MAX_SPENDER_LENGTH = 128;

/** Longest window the room will honour. An hour of headroom over the defaults. */
export const MAX_QUOTA_WINDOW_SECONDS = 3600;

/** Highest cap the room will honour, so a bad caller cannot ask for "unlimited". */
export const MAX_QUOTA_LIMIT = 10_000;

/**
 * Defaults, chosen against what the endpoints actually cost rather than round
 * numbers. A generation is 1–3 `claude-sonnet-5` requests at `max_tokens: 4096`;
 * a transcription is up to 1 MiB of audio through Whisper.
 *
 * Per hour: 20 generations is far more than a household will ever type at a
 * board, and 60 transcriptions allows a genuinely chatty evening — while a
 * board-wide ceiling of 60/200 bounds what any number of paired phones can
 * spend together.
 */
export const DEFAULT_QUOTA: Record<QuotaEndpoint, QuotaPolicy> = {
  generate: { spenderLimit: 20, boardLimit: 60, windowSeconds: 3600 },
  transcribe: { spenderLimit: 60, boardLimit: 200, windowSeconds: 3600 },
};

export interface QuotaPolicy {
  readonly spenderLimit: number;
  readonly boardLimit: number;
  readonly windowSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* Spender identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Who is spending. An owner is identified by their account, a paired phone by
 * the nonce inside the grant it presented.
 *
 * The nonce is the right key precisely because it is minted fresh and randomly
 * per grant and is covered by the grant's MAC: a caller cannot choose it, cannot
 * forge one belonging to somebody else, and cannot strip it without invalidating
 * the token that carries it.
 *
 * The `owner:` / `grant:` prefixes keep the two namespaces from ever colliding.
 */
export const spenderId = (access: {
  readonly via: "owner" | "grant";
  readonly ownerId: string;
  readonly grantNonce: string | null;
}): string =>
  access.via === "owner" || access.grantNonce === null
    ? `owner:${access.ownerId}`
    : `grant:${access.grantNonce}`;

/* -------------------------------------------------------------------------- */
/* Window arithmetic                                                          */
/* -------------------------------------------------------------------------- */

/** Start of the fixed window `now` falls in, in epoch ms. */
export const windowStart = (now: number, windowSeconds: number): number => {
  const windowMs = windowSeconds * 1000;
  return Math.floor(now / windowMs) * windowMs;
};

/**
 * Whole seconds until the current window rolls over — what a refused caller is
 * told to wait. Rounded **up** so the advice is never optimistic, and floored at
 * 1 so a caller refused in the last few milliseconds of a window is not told to
 * retry in zero seconds.
 */
export const retryAfterSeconds = (now: number, windowSeconds: number): number => {
  const windowMs = windowSeconds * 1000;
  const elapsed = now - windowStart(now, windowSeconds);
  return Math.max(1, Math.ceil((windowMs - elapsed) / 1000));
};

/* -------------------------------------------------------------------------- */
/* Storage keys                                                               */
/* -------------------------------------------------------------------------- */

/** Prefix for every quota counter, so pruning can scan just those. */
export const QUOTA_KEY_PREFIX = "quota:";

/**
 * `quota:<endpoint>:s:<spender>:<windowStart>` — one spender's counter.
 *
 * The window start is in the key rather than only in the value so a new window
 * is a new key: nothing has to be reset, and an expired counter is simply an
 * orphan for the pruner to collect.
 */
export const spenderQuotaKey = (
  endpoint: QuotaEndpoint,
  spender: string,
  start: number
): string => `${QUOTA_KEY_PREFIX}${endpoint}:s:${spender}:${start}`;

/** `quota:<endpoint>:b:<windowStart>` — the whole board's counter. */
export const boardQuotaKey = (endpoint: QuotaEndpoint, start: number): string =>
  `${QUOTA_KEY_PREFIX}${endpoint}:b:${start}`;

/* -------------------------------------------------------------------------- */
/* Stored value                                                               */
/* -------------------------------------------------------------------------- */

export interface QuotaEntry {
  readonly count: number;
  /** Epoch ms at which this counter's window ends; drives pruning. */
  readonly expiresAt: number;
}

/**
 * Durable Object storage hands back `unknown`. Anything that is not a
 * well-formed entry is treated as absent — a corrupt counter restarts at zero
 * rather than refusing every call for the rest of the window, because failing
 * *open* on unreadable bookkeeping is better than bricking a family's board, and
 * the board-wide ceiling still bounds the damage.
 */
export const isQuotaEntry = (value: unknown): value is QuotaEntry =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as QuotaEntry).count === "number" &&
  Number.isFinite((value as QuotaEntry).count) &&
  typeof (value as QuotaEntry).expiresAt === "number" &&
  Number.isFinite((value as QuotaEntry).expiresAt);

/** Current count for a slot, or 0 when it is absent or unreadable. */
export const readCount = (value: unknown): number =>
  isQuotaEntry(value) ? value.count : 0;

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

export const SpendQuotaRequest = Schema.Struct({
  endpoint: Schema.Literal(...QUOTA_ENDPOINTS),
  spender: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_SPENDER_LENGTH)
  ),
  spenderLimit: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_QUOTA_LIMIT)
  ),
  boardLimit: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_QUOTA_LIMIT)
  ),
  windowSeconds: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_QUOTA_WINDOW_SECONDS)
  ),
});
export type SpendQuotaRequest = typeof SpendQuotaRequest.Type;

const decodeSpendQuotaSchema = Schema.decodeUnknownEither(SpendQuotaRequest);

/** `null` on anything unparseable — the caller treats that as a refusal. */
export const parseSpendQuotaRequest = (
  raw: string
): SpendQuotaRequest | null => {
  const parsed = Either.try({
    try: () => JSON.parse(raw) as unknown,
    catch: () => "invalid-json" as const,
  });
  if (Either.isLeft(parsed)) return null;
  const decoded = decodeSpendQuotaSchema(parsed.right);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * The room's answer. `retryAfter` is 0 when allowed — there is nothing to wait
 * for — and the seconds to the window edge when refused.
 */
export const QuotaSpendResult = Schema.Struct({
  type: Schema.Literal("quota"),
  allowed: Schema.Boolean,
  retryAfter: Schema.Number,
});
export type QuotaSpendResult = typeof QuotaSpendResult.Type;

export const quotaSpendResult = (
  allowed: boolean,
  retryAfter: number
): QuotaSpendResult => ({ type: "quota", allowed, retryAfter });

/**
 * Parse the room's answer back on the client side. `null` on anything
 * unreadable, which the service turns into a fail-closed refusal.
 */
const decodeQuotaResultSchema = Schema.decodeUnknownEither(QuotaSpendResult);

export const parseQuotaSpend = (payload: unknown): QuotaSpendResult | null => {
  const decoded = decodeQuotaResultSchema(payload);
  return Either.isRight(decoded) ? decoded.right : null;
};

/* -------------------------------------------------------------------------- */
/* The decision                                                               */
/* -------------------------------------------------------------------------- */

export interface QuotaDecision {
  readonly allowed: boolean;
  readonly retryAfter: number;
  readonly spenderCount: number;
  readonly boardCount: number;
}

/**
 * Pure decision, so the room's handler stays platform glue and this stays
 * testable without a Durable Object.
 *
 * **A refused call increments nothing.** Counting refusals would let a caller
 * who is already over the limit keep pushing the window out from under
 * everybody else, and it would make the board bucket climb on traffic that
 * never cost a cent.
 */
export const decideQuota = (input: {
  readonly spenderCount: number;
  readonly boardCount: number;
  readonly spenderLimit: number;
  readonly boardLimit: number;
  readonly now: number;
  readonly windowSeconds: number;
}): QuotaDecision => {
  const allowed =
    input.spenderCount < input.spenderLimit &&
    input.boardCount < input.boardLimit;

  return {
    allowed,
    retryAfter: allowed ? 0 : retryAfterSeconds(input.now, input.windowSeconds),
    spenderCount: allowed ? input.spenderCount + 1 : input.spenderCount,
    boardCount: allowed ? input.boardCount + 1 : input.boardCount,
  };
};
