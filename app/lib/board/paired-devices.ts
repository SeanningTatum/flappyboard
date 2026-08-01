import { Either, Schema } from "effect";

import { MAX_NONCE_LENGTH } from "./protocol";

/**
 * Per-device pairing records — the pure half of `feat-011` (family grants).
 *
 * A controller grant (`fbg1`, see `pairing.ts`) is a stateless signed token: the
 * board keeps nothing about it, and the only lever that refuses one is bumping
 * the board's `grantEpoch`, which invalidates *every* phone in the house at once.
 * That is a fine panic button and a terrible way to say "my kid's old phone is in
 * a drawer somewhere, take it off the board".
 *
 * This module adds the state that makes per-device revocation possible: one small
 * record per grant, held in the board's Durable Object, keyed by the nonce the
 * grant already carries inside its MAC. As everywhere else in `app/lib/board`,
 * the Durable Object owns storage and the network and this owns *meaning* — every
 * export here is total (no throws, no I/O), so the interesting decisions are
 * unit-testable without miniflare.
 *
 * ## The one rule everything else is shaped around
 *
 * **A grant with no record is LIVE, not dead.**
 *
 * Every phone paired before this ships holds a perfectly valid signed grant and
 * has no record in the room, because nothing was writing records yet. If "no
 * record" meant "revoked", the deploy that introduced this file would silently
 * un-pair every device in every household — a data-loss-shaped outage caused
 * purely by a schema gaining a row type.
 *
 * So absence never refuses. Revocation is an explicit **tombstone** written under
 * {@link revokedKey}, and it is the presence of that tombstone — never the
 * absence of a record — that turns a grant away. The tombstone is also why the
 * two live in separate key spaces rather than one record with a `revoked: true`
 * flag: a flag has to survive every future prune, overflow eviction and decode
 * bug to keep refusing, whereas a tombstone is a tiny key whose only job is to
 * exist. Losing a record is a downgrade to "unknown but allowed"; losing a
 * tombstone would be a downgrade to "un-revoked", and only one of those is
 * acceptable.
 *
 * The corollary, spelled out in {@link decideTouch}: this record's `expiresAt`
 * never refuses a grant either. Expiry is judged by the token's own signed
 * `expiresAt`, which is the value the browser cookie and the MAC agree on.
 * Judging it here as well would create two clocks that can disagree, and the
 * disagreement would present as a phone that is refused while holding a token it
 * can prove is still valid. The record's `expiresAt` exists for exactly one
 * purpose: telling the pruner when the bookkeeping is safe to delete.
 */

/* -------------------------------------------------------------------------- */
/* Storage keys                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Prefix for a device record, so the pruner and the owner's device list can scan
 * just these — the same discipline as `NONCE_KEY_PREFIX` and `QUOTA_KEY_PREFIX`.
 */
export const GRANT_KEY_PREFIX = "grant:";

export const grantKey = (nonce: string): string =>
  `${GRANT_KEY_PREFIX}${nonce}`;

/**
 * Prefix for a revocation tombstone. Deliberately a *different* key space from
 * {@link GRANT_KEY_PREFIX}: a `list({ prefix })` over device records must never
 * hand a tombstone to the decoder, and — far more importantly — deleting a record
 * must never be capable of deleting the tombstone that refuses it.
 */
export const REVOKED_KEY_PREFIX = "revoked:";

export const revokedKey = (nonce: string): string =>
  `${REVOKED_KEY_PREFIX}${nonce}`;

/* -------------------------------------------------------------------------- */
/* Bounds                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound on a device name. This is one text field, typed once, on a phone
 * keyboard — "Kai's phone", "kitchen iPad". The ceiling is not a UX opinion about
 * how long a name should be; it is here so a caller can never use the name to
 * write an unbounded value into Durable Object storage, the same rule
 * `MAX_NONCE_LENGTH` enforces for keys.
 */
export const MAX_DEVICE_NAME_LENGTH = 40;

/**
 * Upper bound on how many device records one board keeps.
 *
 * **This is a storage bound, not a policy on how many phones a family may have.**
 * Nothing here refuses a grant for being the 65th — a grant is refused by a
 * tombstone and by nothing else. When the bound binds, the room drops the record
 * with the oldest `lastSeenAt` (see {@link overflowVictims}), which downgrades
 * that device from "named in the owner's list" to "unknown but allowed" — exactly
 * the grandfathered state every pre-existing phone is already in.
 *
 * 64 is chosen to be far past a household and far short of anything that makes a
 * `list()` over one board expensive. A board that somehow exceeds it is either a
 * very unusual house or a caller minting grants in a loop, and the second case is
 * what the bound is really for.
 */
export const MAX_PAIRED_DEVICES = 64;

/**
 * Longest life a caller may ask the room to remember a device record for.
 *
 * 400 days is the ceiling browsers clamp a cookie's `Max-Age` to, and the record
 * exists to shadow a cookie: remembering a device for longer than its cookie can
 * possibly survive would only accumulate records for phones that can no longer
 * present anything. Mirrors `MAX_NONCE_TTL_SECONDS` — it bounds what a *caller*
 * may request, and says nothing about what the app actually asks for
 * (`DEFAULT_GRANT_TTL_SECONDS`, 30 days).
 */
export const MAX_GRANT_TTL_SECONDS = 400 * 24 * 60 * 60;

/* -------------------------------------------------------------------------- */
/* The record                                                                 */
/* -------------------------------------------------------------------------- */

/** Epoch-ms timestamps: whole, non-negative. Anything else is corruption. */
const Timestamp = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0)
);

/**
 * One paired device, as persisted in the room.
 *
 * `nonce` is the grant's own nonce and therefore the identity of the device: it
 * is minted randomly per grant and covered by the token's MAC, so a caller cannot
 * choose one, cannot forge somebody else's and cannot strip it without breaking
 * the token that carries it — the same property that makes it the right quota key
 * in `quota.ts`.
 *
 * `name` is nullable because naming is optional by design. A phone that paired
 * without typing a name is a normal, fully-authorised device; it simply shows up
 * unnamed in the owner's list.
 *
 * This is untrusted on read — Durable Object storage hands back `unknown` and an
 * older (or newer) deploy may have written the value — hence a schema rather than
 * a bare interface. See {@link decodePairedDevice}.
 */
export const PairedDeviceRecord = Schema.Struct({
  nonce: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_NONCE_LENGTH)
  ),
  name: Schema.NullOr(
    Schema.String.pipe(Schema.maxLength(MAX_DEVICE_NAME_LENGTH))
  ),
  issuedAt: Timestamp,
  lastSeenAt: Timestamp,
  /** When the *bookkeeping* may be collected. Never what refuses a grant. */
  expiresAt: Timestamp,
});
export type PairedDeviceRecord = typeof PairedDeviceRecord.Type;

const decodeRecordSchema = Schema.decodeUnknownEither(PairedDeviceRecord);

/**
 * Validate a persisted record on read; `null` when it cannot be trusted.
 *
 * Failing to decode is safe in the only direction that matters: an unreadable
 * record is treated as absent, and absent means live (see the module note). The
 * cost of a strict decode is therefore a device that disappears from the owner's
 * list, never a device that loses access — so this stays strict rather than
 * attempting repair.
 */
export const decodePairedDevice = (
  input: unknown
): PairedDeviceRecord | null => {
  const decoded = decodeRecordSchema(input);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * Fold a caller-supplied name into what we are willing to store, or `null`.
 *
 * Trims, collapses internal whitespace runs to a single space (so "Kai's   phone"
 * and "Kai's phone" are one name in the owner's list rather than two that look
 * identical), then truncates to {@link MAX_DEVICE_NAME_LENGTH}.
 *
 * `null` is a **normal return, not a failure**: the name is optional, so a
 * non-string, an empty string and a string of spaces all mean the same thing —
 * "this device has no name" — and none of them should stop a pairing from being
 * recorded. Truncation happens after collapsing so the limit counts the
 * characters that will actually be shown.
 */
export const normalizeDeviceName = (input: unknown): string | null => {
  if (typeof input !== "string") return null;
  const collapsed = input.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_DEVICE_NAME_LENGTH);
};

/* -------------------------------------------------------------------------- */
/* Control-plane requests                                                     */
/* -------------------------------------------------------------------------- */

/**
 * These are HTTP-only room requests, for the same reason `SpendNonceRequest` is:
 * they are authorised at the HTTP boundary (an owner session, or a verified
 * grant) and reach the room over the DO stub, never over a socket. Keeping them
 * out of `BoardCommand` is the enforcement — a browser holding a board socket
 * cannot ask the room to name, renew or revoke a pairing.
 */

const decodeText = (raw: string | ArrayBuffer): string | null => {
  if (typeof raw === "string") return raw;
  const decoded = Either.try({
    try: () => new TextDecoder().decode(raw),
    catch: () => "undecodable" as const,
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

/** JSON or `null`. A literal `null` body is indistinguishable from a failure — and
 * is equally unusable, so the collapse costs nothing. */
const parseJson = (raw: string | ArrayBuffer): unknown => {
  const text = decodeText(raw);
  if (text === null) return null;
  const parsed = Either.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => "invalid-json" as const,
  });
  return Either.isRight(parsed) ? parsed.right : null;
};

/** The nonce as it appears on the wire — bounded exactly like a ledger spend. */
const Nonce = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_NONCE_LENGTH)
);

const TtlSeconds = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(MAX_GRANT_TTL_SECONDS)
);

/**
 * "Remember this device." Sent once, at pairing, with whatever the owner typed.
 *
 * `name` is optional on the wire because the field is optional in the UI, and an
 * over-long name is **rejected rather than truncated**: the caller runs
 * {@link normalizeDeviceName} on its own input before sending, so a name that
 * arrives over the limit is a malformed request from something that skipped that
 * step, not an ordinary long name. Same discipline as `parseSpendNonceRequest`
 * and its TTL — the caller normalises, the room validates.
 */
export const RecordGrantRequest = Schema.Struct({
  nonce: Nonce,
  name: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_DEVICE_NAME_LENGTH))
  ),
  ttlSeconds: TtlSeconds,
});
export type RecordGrantRequest = typeof RecordGrantRequest.Type;

const decodeRecordGrantSchema = Schema.decodeUnknownEither(RecordGrantRequest);

/** `null` on anything unparseable — the room answers 400 rather than guessing. */
export const parseRecordGrantRequest = (
  raw: string | ArrayBuffer
): RecordGrantRequest | null => {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const decoded = decodeRecordGrantSchema(parsed);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * "This device just showed up." Sent on every socket upgrade, which is what makes
 * the 30-day grant slide (see `DEFAULT_GRANT_TTL_SECONDS`).
 *
 * Carries no name on purpose: a touch is the hot path and must never be able to
 * rewrite — or blank — a name the owner set at pairing. See {@link renewRecord}.
 */
export const TouchGrantRequest = Schema.Struct({
  nonce: Nonce,
  ttlSeconds: TtlSeconds,
});
export type TouchGrantRequest = typeof TouchGrantRequest.Type;

const decodeTouchGrantSchema = Schema.decodeUnknownEither(TouchGrantRequest);

/** `null` on anything unparseable. */
export const parseTouchGrantRequest = (
  raw: string | ArrayBuffer
): TouchGrantRequest | null => {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const decoded = decodeTouchGrantSchema(parsed);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * "Call this device X." Sent by the phone itself, after pairing, when it notices
 * the owner's list has no label for it.
 *
 * Unlike {@link TouchGrantRequest} this carries a name — that is the entire
 * point of the call — and unlike {@link RecordGrantRequest} the name is
 * **required**: the one thing this request exists to do is set one, so a
 * nameless one is a malformed request, not an unnamed device. Over-long is
 * rejected rather than truncated, same discipline as `RecordGrantRequest`: the
 * caller runs {@link normalizeDeviceName} before sending.
 *
 * The TTL rides along for the same reason it does on a touch: naming a
 * grandfathered phone (one with no record yet) *creates* its record, and a
 * record cannot be written without knowing when the bookkeeping may be
 * collected.
 */
export const NameGrantRequest = Schema.Struct({
  nonce: Nonce,
  name: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_DEVICE_NAME_LENGTH)
  ),
  ttlSeconds: TtlSeconds,
});
export type NameGrantRequest = typeof NameGrantRequest.Type;

const decodeNameGrantSchema = Schema.decodeUnknownEither(NameGrantRequest);

/** `null` on anything unparseable. */
export const parseNameGrantRequest = (
  raw: string | ArrayBuffer
): NameGrantRequest | null => {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const decoded = decodeNameGrantSchema(parsed);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * "Un-pair this device." Owner-only at the HTTP boundary.
 *
 * No TTL: a tombstone outlives the grant it refuses, because a tombstone that
 * expired early would silently re-admit the device it was written to exclude. The
 * room collects one only once the grant it names cannot possibly still verify.
 */
export const RevokeGrantRequest = Schema.Struct({
  nonce: Nonce,
});
export type RevokeGrantRequest = typeof RevokeGrantRequest.Type;

const decodeRevokeGrantSchema = Schema.decodeUnknownEither(RevokeGrantRequest);

/** `null` on anything unparseable. */
export const parseRevokeGrantRequest = (
  raw: string | ArrayBuffer
): RevokeGrantRequest | null => {
  const parsed = parseJson(raw);
  if (parsed === null) return null;
  const decoded = decodeRevokeGrantSchema(parsed);
  return Either.isRight(decoded) ? decoded.right : null;
};

/* -------------------------------------------------------------------------- */
/* Control-plane results                                                      */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The room's answer to a touch: is this grant still welcome, and what is the
 * device called?
 *
 * Each `parse*` below returns `null` on an unrecognised payload rather than a
 * plausible default — the same discipline as `parseNonceSpend`. A shape mismatch
 * between the worker and the room must surface as a typed error, because reading
 * an unreadable answer as `live: false` would turn a deploy skew into a
 * house-wide un-pairing that looks exactly like a deliberate revoke.
 */
export const GrantTouchResult = Schema.Struct({
  type: Schema.Literal("grant-touch"),
  live: Schema.Boolean,
  name: Schema.NullOr(Schema.String),
});
export type GrantTouchResult = typeof GrantTouchResult.Type;

export const grantTouchResult = (
  live: boolean,
  name: string | null
): GrantTouchResult => ({ type: "grant-touch", live, name });

const decodeGrantTouchSchema = Schema.decodeUnknownEither(GrantTouchResult);

export const parseGrantTouch = (
  payload: unknown
): { readonly live: boolean; readonly name: string | null } | null => {
  if (!isRecord(payload)) return null;
  const decoded = decodeGrantTouchSchema(payload);
  if (Either.isLeft(decoded)) return null;
  return { live: decoded.right.live, name: decoded.right.name };
};

/** The owner's device list. Ordering is the room's business, not the schema's. */
export const PairedDeviceList = Schema.Struct({
  type: Schema.Literal("paired-devices"),
  devices: Schema.Array(PairedDeviceRecord),
});
export type PairedDeviceList = typeof PairedDeviceList.Type;

export const pairedDeviceList = (
  devices: ReadonlyArray<PairedDeviceRecord>
): PairedDeviceList => ({ type: "paired-devices", devices });

const decodeDeviceListSchema = Schema.decodeUnknownEither(PairedDeviceList);

export const parsePairedDevices = (
  payload: unknown
): ReadonlyArray<PairedDeviceRecord> | null => {
  if (!isRecord(payload)) return null;
  const decoded = decodeDeviceListSchema(payload);
  return Either.isRight(decoded) ? decoded.right.devices : null;
};

/**
 * Did *this* call write the tombstone? `false` means it was already there, which
 * the UI can report as "already un-paired" rather than as a failure.
 */
export const GrantRevokeResult = Schema.Struct({
  type: Schema.Literal("grant-revoke"),
  revoked: Schema.Boolean,
});
export type GrantRevokeResult = typeof GrantRevokeResult.Type;

export const grantRevokeResult = (revoked: boolean): GrantRevokeResult => ({
  type: "grant-revoke",
  revoked,
});

const decodeGrantRevokeSchema = Schema.decodeUnknownEither(GrantRevokeResult);

export const parseGrantRevoke = (payload: unknown): boolean | null => {
  if (!isRecord(payload)) return null;
  const decoded = decodeGrantRevokeSchema(payload);
  return Either.isRight(decoded) ? decoded.right.revoked : null;
};

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export interface TouchDecision {
  readonly live: boolean;
  readonly name: string | null;
}

/**
 * Should this grant still be honoured, and what is the device called?
 *
 * Three cases, and the second is the entire reason this feature is shaped the way
 * it is:
 *
 * 1. **Tombstone present** → `live: false`, whatever else is true. The tombstone
 *    is the only thing in the system that refuses a grant, so it is the only
 *    thing checked first. A record may or may not still exist alongside it — a
 *    revoke writes the tombstone and drops the record, but a prune racing a
 *    revoke could leave either — and neither ordering may change the answer.
 * 2. **No record, no tombstone** → `live: true`, `name: null`. Every phone paired
 *    before this shipped is in exactly this state, as is any device whose record
 *    was pruned or evicted for overflow. Reading absence as revocation here is
 *    the one-line bug that would un-pair every household on deploy.
 * 3. **Record present, no tombstone** → `live: true` with the recorded name.
 *
 * **An expired record is still live.** `expiresAt` on the record is pruning
 * metadata; the authority on whether a grant has expired is the token's own
 * signed `expiresAt`, already checked by `verifyGrant` before anything reaches
 * this function. Re-deciding it here would put two clocks on one question, and
 * the failure mode of that disagreement is a phone refused while holding a token
 * it can prove is valid — indistinguishable, from the sofa, from a broken board.
 */
export const decideTouch = (input: {
  readonly record: PairedDeviceRecord | null;
  readonly revoked: boolean;
  readonly now: number;
}): TouchDecision =>
  input.revoked
    ? { live: false, name: null }
    : { live: true, name: input.record?.name ?? null };

/**
 * Upsert a device record: create one on first sight, slide the window on every
 * later touch.
 *
 * What is preserved: `issuedAt`, so the owner's list can say when a device first
 * paired rather than when it last connected; and the **name already on the
 * record**, so a touch — which carries no name at all — can never blank what the
 * owner typed at pairing. A record that never captured a name can still gain one
 * later, since `null` there is "not named yet", not "deliberately anonymous".
 *
 * What always moves: `lastSeenAt` to `now` (this is the value overflow eviction
 * sorts on, so it has to be honest), and `expiresAt` to `now + ttl`. Sliding
 * `expiresAt` on every touch is what keeps a phone in weekly use from ever having
 * its bookkeeping collected out from under it.
 */
export const renewRecord = (input: {
  readonly record: PairedDeviceRecord | null;
  readonly nonce: string;
  readonly name: string | null;
  readonly now: number;
  readonly ttlSeconds: number;
}): PairedDeviceRecord => ({
  nonce: input.nonce,
  name: input.record?.name ?? input.name,
  issuedAt: input.record?.issuedAt ?? input.now,
  lastSeenAt: input.now,
  expiresAt: input.now + input.ttlSeconds * 1000,
});

export interface NameDecision {
  readonly live: boolean;
  /** The record to persist; `null` when the refusal means "write nothing". */
  readonly record: PairedDeviceRecord | null;
}

/**
 * May this device be named, and what does the record look like afterwards?
 *
 * The decision mirrors {@link decideTouch} case for case, because a naming call
 * is a touch that also sets the name:
 *
 * 1. **Tombstone present** → `live: false`, no record. Naming a revoked device
 *    must not resurrect the record the revoke removed — the same rule
 *    `handleTouchGrant` enforces by writing nothing for a dead grant.
 * 2. **No record, no tombstone** → live, and a *new* record carrying the name.
 *    This is how a grandfathered phone — paired before records existed — gets
 *    into the owner's list without re-pairing: absence is live, so the first
 *    thing the phone ever writes can be its name. `renewRecord` owns the
 *    create-on-first-sight shape (`issuedAt` stamped with `now`).
 * 3. **Record present, no tombstone** → live, same record with the name
 *    **replaced**. This is the one place `renewRecord`'s keep-the-old-name rule
 *    is overridden, deliberately: a touch must never blank a name, but a naming
 *    call is the phone correcting its own label, so the new name wins. The
 *    sliding window still moves — a phone naming itself is alive right now.
 */
export const decideName = (input: {
  readonly record: PairedDeviceRecord | null;
  readonly revoked: boolean;
  readonly nonce: string;
  readonly name: string;
  readonly now: number;
  readonly ttlSeconds: number;
}): NameDecision =>
  input.revoked
    ? { live: false, record: null }
    : {
        live: true,
        record: {
          ...renewRecord({
            record: input.record,
            nonce: input.nonce,
            name: input.name,
            now: input.now,
            ttlSeconds: input.ttlSeconds,
          }),
          name: input.name,
        },
      };

export interface PruneResult {
  /** Storage keys to delete, exactly as they were handed in. */
  readonly dead: ReadonlyArray<string>;
}

/**
 * Which device-record keys the room should collect.
 *
 * Two kinds of dead: entries that no longer decode (an older shape, a partial
 * write, anything the schema refuses) and entries whose `expiresAt` has passed.
 * Both are safe to delete precisely because absence is live — pruning can only
 * ever cost a device its name in the owner's list, never its access.
 *
 * Keys are returned verbatim rather than reconstructed from the decoded nonce:
 * an undecodable entry has no nonce to reconstruct from, and a decoded record
 * whose `nonce` disagreed with its key would otherwise leave the real key behind
 * forever.
 *
 * The boundary is `expiresAt <= now`, not `<`: a record that expires exactly now
 * has no life left, and treating the tie as alive would keep it for one more
 * pass for no reason.
 */
export const pruneDevices = (
  entries: ReadonlyArray<readonly [string, unknown]>,
  now: number
): PruneResult => ({
  dead: entries
    .filter(([, value]) => {
      const record = decodePairedDevice(value);
      return record === null || record.expiresAt <= now;
    })
    .map(([key]) => key),
});

/**
 * Which devices to evict when a board holds more records than
 * {@link MAX_PAIRED_DEVICES}.
 *
 * Oldest `lastSeenAt` first: the phone nobody has connected with in the longest
 * time is the one whose bookkeeping is least missed, and — because absence is
 * live — evicting it costs that device its entry in the owner's list and nothing
 * else. It is not a revoke and must never be reported as one.
 *
 * Returns exactly `records.length - limit` nonces, and an empty array whenever
 * the board is at or under the limit. Ties on `lastSeenAt` are broken by
 * `issuedAt` and then by `nonce`, so two records written in the same millisecond
 * always produce the same eviction rather than whatever order storage happened to
 * list them in — a total order is what makes this testable and what stops two
 * concurrent evictions from picking different victims.
 */
export const overflowVictims = (
  records: ReadonlyArray<PairedDeviceRecord>,
  limit: number
): ReadonlyArray<string> => {
  const excess = records.length - limit;
  if (excess <= 0) return [];

  return [...records]
    .sort(
      (a, b) =>
        a.lastSeenAt - b.lastSeenAt ||
        a.issuedAt - b.issuedAt ||
        (a.nonce < b.nonce ? -1 : a.nonce > b.nonce ? 1 : 0)
    )
    .slice(0, excess)
    .map((record) => record.nonce);
};

/**
 * How long ago a phone last drove the board, as a translation key and a count.
 *
 * Buckets rather than an exact duration, and deliberately coarse. The question
 * this answers is "is this the phone I think it is?", which "yesterday" settles
 * and "23 hours and 14 minutes" does not.
 *
 * Pure, and fed a caller-supplied `now` so it can be tested without a fake
 * clock. (Lived in `components/boards/board-devices.tsx` until the device list
 * moved onto the controller — a helper with no unit test, which is one of the
 * five non-negotiables.)
 */
export const lastSeenKey = (
  lastSeenAt: number,
  now: number
): { key: string; count: number } => {
  const elapsed = Math.max(0, now - lastSeenAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 2) return { key: "devices.justNow", count: 0 };
  if (minutes < 60) return { key: "devices.minutesAgo", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "devices.hoursAgo", count: hours };
  return { key: "devices.daysAgo", count: Math.floor(hours / 24) };
};
