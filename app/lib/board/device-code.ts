import { Either, Schema } from "effect";
import { MAX_TOKEN_LENGTH, bytesToBase64Url } from "./pairing";

/**
 * Device-code pairing: how a TV with no keyboard, no camera and no session gets
 * itself paired by a phone that has all three.
 *
 * The QR flow (`app/lib/board/pairing.ts`) assumes the TV already knows which
 * board it is showing — it mints a code *because* it holds the owner's session.
 * A freshly-opened display holds nothing, and a Samsung TV browser cannot scan
 * anything. So the arrow is reversed: the **TV shows a short code**, the owner
 * types that code into their phone, the phone (which does have a session)
 * approves it, and the approval is pushed back down to the waiting TV. This is
 * RFC 8628's device authorization grant with the polling loop replaced by the
 * socket the display is already holding open.
 *
 * This module is the pure half of that flow: the alphabet, the code shape, the
 * storage key, the wire shapes and the liveness predicate. It has **no I/O, no
 * storage and no clock** — `now` is always a caller-supplied argument, exactly
 * as in `pairing.ts` — so every decision here is unit-testable without a Durable
 * Object or a fake timer. The Durable Object that stores a code and the routes
 * that issue and approve it live elsewhere and import from here.
 *
 * All times are **milliseconds since the epoch** (matching `Date.now()`); TTLs
 * are in seconds, because that is the unit a human and an HTTP header both want.
 */

/* -------------------------------------------------------------------------- */
/* Code shape                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The 32 characters a device code may contain.
 *
 * Two properties, both load-bearing:
 *
 * 1. **Unambiguous across a room.** No `0`/`O`, no `1`/`I` — the four glyphs a
 *    person reliably confuses when reading a code off a TV from the sofa and
 *    typing it on a phone. The danger is not that a misread fails; it is that a
 *    misread *succeeds* against somebody else's code. Removing the confusable
 *    pairs entirely means the transcription error cannot happen in the first
 *    place, which is strictly better than trying to correct it afterwards (see
 *    `normalizeDeviceCode`).
 * 2. **Exactly 32, because 32 divides 256.** `generateDeviceCode` draws one
 *    random byte per character and takes it modulo the alphabet length. That is
 *    only bias-free when the length divides 256 evenly; at, say, 30 characters
 *    the first 16 would come up 9 times per 256 bytes and the rest 8 times, and
 *    the code space would tilt in an attacker's favour for free. A power of two
 *    makes the naive modulo exactly uniform, so the generator needs no rejection
 *    sampling. This is why the alphabet is trimmed to 32 rather than to
 *    "whatever is left after removing the ambiguous glyphs".
 */
export const DEVICE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/**
 * Six characters, i.e. 32^6 ≈ 1.07e9 codes ≈ **30 bits** of entropy.
 *
 * Thirty bits is not a lot — it is far below what any long-lived bearer token
 * would need, and deliberately so, because a human has to read it off a screen
 * and type it. RFC 8628 §5.1 makes exactly this trade and it is only safe
 * because three other things hold simultaneously:
 *
 * - **Short TTL** (`DEVICE_CODE_TTL_SECONDS`, 5 minutes) — the window in which
 *   a guess is worth anything is minutes, not forever.
 * - **Single-use redemption** — an approved code is consumed; a second approval
 *   of the same code is refused (`already-approved`), so a guess that lands
 *   after the real TV has been paired buys nothing.
 * - **An attempt cap** (`MAX_DEVICE_CODE_ATTEMPTS`) — brute force against one
 *   code dies after five tries, which is what turns 2^30 from "a few minutes of
 *   scripted guessing" into "not a viable attack".
 *
 * Lengthening the code is the wrong lever if this ever feels tight: shorten the
 * TTL or tighten the cap first, and only make a household type more characters
 * as a last resort.
 */
export const DEVICE_CODE_LENGTH = 6;

/**
 * Five minutes. Long enough for the whole human loop — notice the code, find
 * your phone, unlock it, open the app, log in if you had been signed out, type
 * six characters — without ever being long enough that a code photographed or
 * glimpsed by a visitor is still worth anything by the time they act on it.
 *
 * It is also the number that makes 30 bits of entropy defensible; see
 * `DEVICE_CODE_LENGTH`.
 */
export const DEVICE_CODE_TTL_SECONDS = 300;

/**
 * How many wrong codes one approval attempt path may burn before it is cut off.
 *
 * Five is comfortably above the "I fat-fingered it" rate for a six-character
 * code and far below anything useful for guessing: five tries against 2^30 is a
 * ~1-in-200-million shot per code lifetime. The cap is the third leg of the
 * entropy argument in `DEVICE_CODE_LENGTH` — without it, a short code is only
 * as strong as the attacker's patience.
 */
export const MAX_DEVICE_CODE_ATTEMPTS = 5;

/* -------------------------------------------------------------------------- */
/* Watcher secret                                                             */
/* -------------------------------------------------------------------------- */

/** 128 bits — collision-free in practice, and never seen by a human. */
export const WATCHER_BYTES = 16;

/**
 * The secret that binds an approval to **the one socket that asked for the
 * code**.
 *
 * A device code is public by construction: it is displayed on a television. The
 * room a code resolves to is derived from the code itself
 * (`deviceCodeRoomName`), so anyone who reads — or guesses — a code can open
 * that room's socket. Without a second factor, whoever is sitting on that socket
 * when the owner taps approve receives the handoff token, and a stranger's
 * screen gets paired to the family's board instead of the TV in the living room.
 *
 * So the TV mints a watcher alongside the code, keeps it to itself (it is never
 * displayed and never leaves the device), and presents it when it subscribes.
 * The room only delivers the approval frame to a subscriber that produced the
 * matching watcher. The code says *which* pairing; the watcher says *who is
 * waiting for it*.
 *
 * base64url via `bytesToBase64Url`, imported rather than re-implemented — a
 * second copy of the encoder is a second place for a padding bug, and this
 * value has to survive a query string intact.
 */
export const generateWatcher = (): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(WATCHER_BYTES)));

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A fresh device code: `DEVICE_CODE_LENGTH` characters drawn uniformly from
 * `DEVICE_CODE_ALPHABET` using `crypto.getRandomValues`.
 *
 * One random byte per character, taken modulo 32. That is unbiased only because
 * the alphabet length divides 256 — see `DEVICE_CODE_ALPHABET`, where the
 * choice of 32 is justified. `Math.random()` would be catastrophic here: the
 * code is the address of the pairing room, so a predictable code is a
 * predictable room.
 */
export const generateDeviceCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(DEVICE_CODE_LENGTH));
  let code = "";
  for (let i = 0; i < bytes.length; i += 1) {
    code += DEVICE_CODE_ALPHABET[bytes[i]! % DEVICE_CODE_ALPHABET.length];
  }
  return code;
};

/* -------------------------------------------------------------------------- */
/* Normalization                                                              */
/* -------------------------------------------------------------------------- */

/** ASCII whitespace plus the separator a TV may print for legibility. */
const SEPARATORS = /[ \t\n\r\f\v-]/g;

const ALPHABET_SET: ReadonlySet<string> = new Set(DEVICE_CODE_ALPHABET);

/**
 * Turn whatever the phone's input field produced into a canonical code, or
 * `null` if it cannot be one.
 *
 * Forgiving about **presentation**: lowercase is upper-cased, and ASCII
 * whitespace and `-` are stripped, so a TV free to render `K7Q2-XM` or
 * `K7Q2 XM` for legibility does not force the owner to reproduce the grouping.
 *
 * Ruthless about **content**, and this is the part worth explaining: there is
 * deliberately **no lossy substitution** here. No `O` → `0`, no `I` → `1`, no
 * `S` → `5`. Two reasons, and the second is the real one:
 *
 * - There is nothing to map onto — the alphabet contains no `0` and no `1` at
 *   all (see `DEVICE_CODE_ALPHABET`), so the usual "helpfully fold the
 *   confusable pair" trick has no target.
 * - Silently rewriting a character the user typed does not fix a typo, it
 *   *converts a typo into a different valid code*. `K7Q2XO` is not a code; if
 *   this folded the `O` to `0` it still would not be one, but any similar
 *   in-alphabet fold would happily hand back a well-formed code addressing
 *   somebody else's pairing room. Refusing is the safe answer: the owner
 *   retypes six characters, which costs three seconds, instead of approving a
 *   stranger's TV.
 *
 * Total, and `unknown`-taking, because the input arrives from a form body or a
 * query string where "it is a string" is an assumption, not a fact.
 */
export const normalizeDeviceCode = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const candidate = input.toUpperCase().replace(SEPARATORS, "");
  if (candidate.length !== DEVICE_CODE_LENGTH) return null;
  for (const character of candidate) {
    if (!ALPHABET_SET.has(character)) return null;
  }
  return candidate;
};

/* -------------------------------------------------------------------------- */
/* Storage / addressing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The one key a per-code Durable Object writes.
 *
 * A code's room holds exactly one record for its whole life, so there is no
 * prefix to scan and no namespace to keep apart — unlike the nonce ledger
 * (`NONCE_KEY_PREFIX`) or the quota counters (`QUOTA_KEY_PREFIX`), which share
 * a room with everything else a board does. A flat constant is the honest shape
 * for "this instance is about one thing".
 */
export const DEVICE_CODE_KEY = "device-code";

/**
 * The Durable Object instance name a code resolves to.
 *
 * **The code is the address.** There is no lookup table mapping codes to rooms
 * and no index to consult: both the TV that issued the code and the phone that
 * types it derive the same room name from the same six characters, and that is
 * how they find each other with no shared state beyond the code itself.
 *
 * Which is precisely why the code needs real entropy (see
 * `DEVICE_CODE_LENGTH`): guessing a code is not guessing a password that some
 * server will then check — it is *naming a room and walking in*. The watcher
 * secret (`generateWatcher`) exists because that door cannot be locked.
 *
 * The `code:` prefix keeps this namespace clear of the board-id-named rooms
 * that share the same Durable Object namespace.
 */
export const deviceCodeRoomName = (code: string): string => `code:${code}`;

/* -------------------------------------------------------------------------- */
/* Persisted record                                                           */
/* -------------------------------------------------------------------------- */

/** Epoch-millisecond timestamps: whole numbers, never floats. */
const EpochMs = Schema.Number.pipe(Schema.int());

/**
 * What a code's room persists between the TV asking for a code and the owner
 * approving it.
 *
 * A schema rather than a bare interface for the same reason `BoardRoomState` is
 * one: Durable Object storage hands back `unknown`, and the bytes in it may have
 * been written by an older deploy with a different shape. Persisted state is
 * untrusted on read — "we wrote it" is not the same as "it is well-formed
 * today".
 */
export const DeviceCodeRecord = Schema.Struct({
  code: Schema.String,
  /** The TV's secret. Compared against the subscriber's; never displayed. */
  watcher: Schema.String,
  issuedAt: EpochMs,
  expiresAt: EpochMs,
});
export type DeviceCodeRecord = typeof DeviceCodeRecord.Type;

const decodeDeviceCodeRecordSchema =
  Schema.decodeUnknownEither(DeviceCodeRecord);

/**
 * Validate a persisted record on read; `null` when it cannot be trusted.
 *
 * A `null` here is treated as "no such code" rather than as an error: an
 * unreadable record is a code nobody can prove they own, and the TV's next tick
 * mints a fresh one anyway.
 */
export const decodeDeviceCodeRecord = (
  input: unknown
): DeviceCodeRecord | null => {
  const decoded = decodeDeviceCodeRecordSchema(input);
  return Either.isRight(decoded) ? decoded.right : null;
};

/* -------------------------------------------------------------------------- */
/* Request shapes — control plane, HTTP only                                  */
/* -------------------------------------------------------------------------- */

/**
 * Both requests below reach the room over the Durable Object stub, never over a
 * socket — the same rule `SpendNonceRequest` follows. Issuing a code and
 * approving one are authorised at the HTTP boundary (a device grant for the
 * first, the owner's session for the second), so keeping them off the socket
 * union is the enforcement: a browser holding a subscription can wait for an
 * approval but can never mint or grant one.
 *
 * `parseWatchDeviceCodeRequest` has no counterpart here on purpose — a
 * subscriber presents its watcher as a query parameter on the upgrade request,
 * because a WebSocket handshake has no body to put it in.
 */

/** A board id is a bounded identifier, not free text; 128 chars is generous. */
export const MAX_BOARD_ID_LENGTH = 128;

const decodeText = (raw: string | ArrayBuffer): string | null => {
  if (typeof raw === "string") return raw;
  const decoded = Either.try({
    try: () => new TextDecoder().decode(raw),
    catch: () => "undecodable" as const,
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * Bytes (or a string) to a JSON value, or `null`. A body that *is* the JSON
 * literal `null` collapses into the same answer as unparseable, which is
 * correct: neither is a request either schema below would accept.
 */
const parseJson = (raw: string | ArrayBuffer): unknown => {
  const text = decodeText(raw);
  if (text === null) return null;
  const parsed = Either.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => "invalid-json" as const,
  });
  return Either.isLeft(parsed) ? null : parsed.right;
};

/**
 * The TV asking its code's room to remember a code it just generated.
 *
 * `ttlSeconds` is caller-supplied but capped at `DEVICE_CODE_TTL_SECONDS`, so a
 * call site can shorten a code's life but never extend it — the ceiling is a
 * property of the room, not a convention at the call site. Floored at 1 rather
 * than 0 because a zero-second code is already dead on arrival and would only
 * ever produce a confusing `expired` on the very next request.
 *
 * `code` is pinned to exactly `DEVICE_CODE_LENGTH` rather than merely non-empty.
 * Every code that reaches this boundary came from `generateDeviceCode` or
 * `normalizeDeviceCode`, both of which guarantee the length — so anything else
 * is a call site that skipped normalization, and that should fail loudly here
 * rather than address a room no TV is ever watching.
 */
export const IssueDeviceCodeRequest = Schema.Struct({
  code: Schema.String.pipe(
    Schema.minLength(DEVICE_CODE_LENGTH),
    Schema.maxLength(DEVICE_CODE_LENGTH)
  ),
  watcher: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_TOKEN_LENGTH)
  ),
  ttlSeconds: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(DEVICE_CODE_TTL_SECONDS)
  ),
});
export type IssueDeviceCodeRequest = typeof IssueDeviceCodeRequest.Type;

const decodeIssueSchema = Schema.decodeUnknownEither(IssueDeviceCodeRequest);

/** `null` on anything unparseable — the room answers 400 rather than guessing. */
export const parseIssueDeviceCodeRequest = (
  raw: string | ArrayBuffer
): IssueDeviceCodeRequest | null => {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const decoded = decodeIssueSchema(parsed);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * The owner's phone telling a code's room "this code is approved, here is what
 * to hand the TV".
 *
 * `handoff` is the single-use `fbh1` token minted in the request worker, where
 * the session was checked and the board row (and therefore `deviceEpoch`) was
 * read — the room never holds the signing secret. It is bounded by
 * `MAX_TOKEN_LENGTH`, the same ceiling every other token-shaped input is held
 * to, so a room can never be made to store an unbounded string.
 */
export const ApproveDeviceCodeRequest = Schema.Struct({
  code: Schema.String.pipe(
    Schema.minLength(DEVICE_CODE_LENGTH),
    Schema.maxLength(DEVICE_CODE_LENGTH)
  ),
  boardId: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_BOARD_ID_LENGTH)
  ),
  handoff: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_TOKEN_LENGTH)
  ),
});
export type ApproveDeviceCodeRequest = typeof ApproveDeviceCodeRequest.Type;

const decodeApproveSchema =
  Schema.decodeUnknownEither(ApproveDeviceCodeRequest);

/** `null` on anything unparseable. Same contract as the issue parser. */
export const parseApproveDeviceCodeRequest = (
  raw: string | ArrayBuffer
): ApproveDeviceCodeRequest | null => {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const decoded = decodeApproveSchema(parsed);
  return Either.isRight(decoded) ? decoded.right : null;
};

/* -------------------------------------------------------------------------- */
/* Result shapes                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The room's answer to an issue: did this call actually store the code?
 *
 * Tagged `device-code-issue` for the same reason `NonceSpendResult` is tagged
 * `nonce` — the request worker decodes a bare `unknown` off a stub fetch, and a
 * discriminator is what lets it tell "the room answered my question" from "the
 * room answered somebody else's".
 */
export const DeviceCodeIssueResult = Schema.Struct({
  type: Schema.Literal("device-code-issue"),
  issued: Schema.Boolean,
});
export type DeviceCodeIssueResult = typeof DeviceCodeIssueResult.Type;

export const deviceCodeIssueResult = (
  issued: boolean
): DeviceCodeIssueResult => ({ type: "device-code-issue", issued });

/**
 * Why an approval did or did not take.
 *
 * A four-way union rather than a boolean because the three failures want three
 * different words on the owner's phone: `unknown` is "check the code on the
 * screen" (typo, or the TV moved on), `expired` is "the TV will show a new one
 * in a moment", and `already-approved` is "this one is done — you, or somebody,
 * already used it". Collapsing them would make the single most common failure
 * (a typo) indistinguishable from the single most alarming one (a code already
 * spent by someone else). A new outcome is a compile error at every switch
 * rather than a silent string, for the same reason `PairingFailureReason` is a
 * union.
 */
export const DeviceCodeApproveOutcome = Schema.Literal(
  "approved",
  "unknown",
  "expired",
  "already-approved"
);
export type DeviceCodeApproveOutcome = typeof DeviceCodeApproveOutcome.Type;

const approveOutcomes: ReadonlySet<string> = new Set(
  DeviceCodeApproveOutcome.literals
);

export const DeviceCodeApproveResult = Schema.Struct({
  type: Schema.Literal("device-code-approve"),
  outcome: DeviceCodeApproveOutcome,
});
export type DeviceCodeApproveResult = typeof DeviceCodeApproveResult.Type;

export const deviceCodeApproveResult = (
  outcome: DeviceCodeApproveOutcome
): DeviceCodeApproveResult => ({ type: "device-code-approve", outcome });

/* -------------------------------------------------------------------------- */
/* Reading the room's answers back                                            */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read an issue result. Same discipline as `parseNonceSpend`: a missing or
 * non-boolean `issued` is **not** read as `false` — it returns `null` so the
 * caller raises a typed error. Treating an unrecognised payload as a refusal
 * would turn a shape mismatch into a pairing outage that looks exactly like an
 * ordinary collision, and nobody would ever find it.
 */
export const parseDeviceCodeIssue = (payload: unknown): boolean | null => {
  if (!isRecord(payload)) return null;
  if (payload.type !== "device-code-issue") return null;
  return typeof payload.issued === "boolean" ? payload.issued : null;
};

/**
 * Read an approve result. Same rule, and it bites harder here: an unrecognised
 * payload silently read as `"unknown"` would tell the owner they mistyped a code
 * they typed perfectly. `null` instead, so the caller fails with a typed error
 * it can actually log.
 */
export const parseDeviceCodeApprove = (
  payload: unknown
): DeviceCodeApproveOutcome | null => {
  if (!isRecord(payload)) return null;
  if (payload.type !== "device-code-approve") return null;
  const { outcome } = payload;
  return typeof outcome === "string" && approveOutcomes.has(outcome)
    ? (outcome as DeviceCodeApproveOutcome)
    : null;
};

/* -------------------------------------------------------------------------- */
/* Liveness                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Is this code still redeemable at `now`?
 *
 * Strictly `<`, so a code is dead **at** its expiry rather than one millisecond
 * after — matching `verifyPairingToken`'s `now >= expiresAt` rule. The clock is
 * an argument, not a `Date.now()` call, which is what keeps this module free of
 * the platform and testable at the boundary.
 */
export const isDeviceCodeLive = (
  record: DeviceCodeRecord,
  now: number
): boolean => now < record.expiresAt;
