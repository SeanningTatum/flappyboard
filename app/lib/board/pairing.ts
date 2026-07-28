import { Effect, Either } from "effect";
import { ConfigurationError } from "@/models/errors/repository";

/**
 * Pairing: how a phone that has never logged in earns the right to drive
 * exactly one board.
 *
 * Two tokens, one primitive:
 *
 * 1. **Pairing token** — minted by the TV (which holds the owner's session),
 *    printed as a QR, short-lived (~120s), single-use. It proves "the owner's
 *    screen told you about this board, just now".
 * 2. **Controller grant** — minted by the server when a pairing token is
 *    redeemed, stored in an `HttpOnly` cookie, longer-lived. It proves "you may
 *    write to board X" and nothing else. A grant is *not* a session: it names
 *    one board, it can never be presented for another, and it grants no
 *    account-level capability.
 *
 * Both are `prefix.payload.signature`, HMAC-SHA256 over `crypto.subtle` keyed
 * with `BETTER_AUTH_SECRET`. Domain separation is structural: the prefix is part
 * of the signed message, so a grant can never be replayed as a pairing token
 * (and vice versa) even though both are signed with the same key.
 *
 * **Revocation** is the board's `grantEpoch` (a counter on the `board` row). It is
 * part of the signed message for *both* token kinds, so incrementing it changes
 * the key-independent message every outstanding token was signed over and every
 * one of them fails as `bad-signature` — for that board and no other. See
 * `board.revokeControllers` in `app/trpc/routes/board.ts`; the reasoning for
 * covering the pairing token too is on `signingMessage` below.
 *
 * This module is platform-free and total: no storage, no clock, no I/O beyond
 * WebCrypto. Expiry is judged against a caller-supplied `now`, and single-use is
 * the caller's job — this module only *exposes* the nonce, it never remembers
 * which nonces have been spent. Both choices exist so every decision here is
 * unit-testable without a Durable Object, a database, or a fake timer.
 *
 * All times are **milliseconds since the epoch** (matching `Date.now()`); TTLs
 * are in seconds because that is what a `Max-Age` cookie attribute and a human
 * both want.
 */

/* -------------------------------------------------------------------------- */
/* Format constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * First segment of a token: format version *and* purpose in one string. It is
 * covered by the signature, so bumping the version or swapping the purpose
 * invalidates every token minted under the old one — no separate key rotation
 * needed to retire a format.
 */
export const PAIRING_PREFIX = "fbp1";
export const GRANT_PREFIX = "fbg1";

/** ~2 minutes: long enough to walk to the TV and scan, short enough that a
 * photographed QR is worthless by the time it is shared. */
export const DEFAULT_PAIRING_TTL_SECONDS = 120;

/** A grant outlives the pairing token by design — the phone stays the remote for
 * the evening without rescanning. */
export const DEFAULT_GRANT_TTL_SECONDS = 12 * 60 * 60;

/**
 * Hard ceiling on an accepted token. A 6KB query string is not a token, and
 * rejecting it on length means WebCrypto is never handed unbounded attacker
 * input. Our own tokens are ~150 chars.
 */
export const MAX_TOKEN_LENGTH = 512;

/** Exactly `prefix.payload.signature`. Anything else is malformed by definition. */
const SEGMENT_COUNT = 3;

/** 128 bits of nonce — collision-free in practice, cheap in a QR. */
const NONCE_BYTES = 16;

/** Padding-free base64url alphabet. Used to reject junk before it reaches atob. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Cookie name prefix for a controller grant. */
export const GRANT_COOKIE_PREFIX = "fb_grant_";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Why a token was refused. A typed union rather than `false` plus a message:
 * the route logs the precise reason and tells the client only "rescan", and a
 * new reason is a compile error at every switch instead of a silent string.
 */
export type PairingFailureReason = "malformed" | "bad-signature" | "expired";

export interface PairingClaims {
  readonly boardId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
}

export type TokenVerification =
  | {
      readonly ok: true;
      readonly nonce: string;
      readonly issuedAt: number;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: PairingFailureReason };

export interface MintTokenInput {
  readonly boardId: string;
  readonly secret: string;
  /**
   * The board's current `grantEpoch`, read off the `board` row. Bound into the
   * signed message, so every token minted under an older epoch is dead. Required
   * rather than defaulted: a call site that forgot it would mint tokens that
   * survive revocation, and that must be a compile error.
   */
  readonly grantEpoch: number;
  /** `Date.now()` at the call site. Passed in so minting is deterministic under test. */
  readonly now: number;
  readonly ttlSeconds?: number;
  /**
   * Test seam only: pin the nonce so a tamper test can hold every other field
   * constant. Production callers must let this default to a fresh random value —
   * a predictable nonce would make the single-use ledger bypassable.
   */
  readonly nonce?: string;
}

export interface VerifyTokenInput {
  readonly token: string;
  /**
   * The board the token is being presented *for*. Bound into the signed message,
   * so a token minted for another board fails as `bad-signature` rather than
   * being accepted and caught later by an equality check.
   */
  readonly boardId: string;
  /**
   * The board's *current* `grantEpoch`. A token signed under any other epoch
   * fails as `bad-signature` — that is the whole revocation mechanism, and it
   * costs no extra round trip because every caller already has the board row.
   */
  readonly grantEpoch: number;
  readonly secret: string;
  /** Caller-supplied clock. The verify path never reads `Date.now()` itself. */
  readonly now: number;
}

const malformed: TokenVerification = { ok: false, reason: "malformed" };
const badSignature: TokenVerification = { ok: false, reason: "bad-signature" };
const expired: TokenVerification = { ok: false, reason: "expired" };

/* -------------------------------------------------------------------------- */
/* Encoding — URL-safe, padding-free                                          */
/* -------------------------------------------------------------------------- */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * base64url with the `=` padding stripped. Tokens travel in a QR code and a
 * query string, so `+`, `/` and `=` are all hostile: two of them are reserved
 * in a query string and the third is why every naive URL round-trip loses bytes.
 */
export const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** `null` on anything that isn't padding-free base64url. Never throws. */
export const base64UrlToBytes = (value: string): Uint8Array | null => {
  if (value.length === 0 || !BASE64URL.test(value)) return null;
  const standard = value.replace(/-/g, "+").replace(/_/g, "/");
  // `atob` implements WHATWG forgiving-base64, so absent padding is fine — but
  // it still throws on a length that can't be a base64 string at all.
  const decoded = Either.try({
    try: () => atob(standard),
    catch: () => "invalid-base64" as const,
  });
  if (Either.isLeft(decoded)) return null;
  const binary = decoded.right;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const encodePayload = (claims: PairingClaims): string =>
  bytesToBase64Url(
    textEncoder.encode(
      JSON.stringify({
        b: claims.boardId,
        i: claims.issuedAt,
        e: claims.expiresAt,
        n: claims.nonce,
      })
    )
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEpochMs = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);

/**
 * Decode the payload segment into claims, or `null`. Only ever called *after*
 * the signature has been verified, so in practice this only rejects a payload
 * we ourselves wrote under an incompatible format — but it stays total anyway,
 * because "we signed it" is not the same as "it is well-formed".
 */
export const decodeClaims = (payload: string): PairingClaims | null => {
  const bytes = base64UrlToBytes(payload);
  if (bytes === null) return null;

  const text = Either.try({
    try: () => textDecoder.decode(bytes),
    catch: () => "undecodable" as const,
  });
  if (Either.isLeft(text)) return null;

  const parsed = Either.try({
    try: () => JSON.parse(text.right) as unknown,
    catch: () => "invalid-json" as const,
  });
  if (Either.isLeft(parsed)) return null;

  const raw = parsed.right;
  if (!isRecord(raw)) return null;
  if (typeof raw.b !== "string" || raw.b.length === 0) return null;
  if (typeof raw.n !== "string" || raw.n.length === 0) return null;
  if (!isEpochMs(raw.i) || !isEpochMs(raw.e)) return null;
  // A token that expires before it was issued is nonsense, not merely stale.
  if (raw.e <= raw.i) return null;

  return { boardId: raw.b, issuedAt: raw.i, expiresAt: raw.e, nonce: raw.n };
};

/* -------------------------------------------------------------------------- */
/* HMAC                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The signed message. Four things matter here:
 *
 * - `prefix` is included, so purpose and format version are authenticated.
 * - `boardId` is included as an *audience*, not just as a payload field. A
 *   verifier recomputes the MAC with the board it was asked about, so a token
 *   minted for board A simply fails to verify for board B — there is no
 *   "compare the ids afterwards" step to forget.
 * - `boardId` is length-prefixed. A board id is a bounded string but not a
 *   restricted charset, so plain concatenation would be ambiguous: `("a", "b.c")`
 *   and `("a.b", "c")` would otherwise produce the same message. Length framing
 *   makes the encoding injective.
 * - `grantEpoch` is included, which is what makes revocation possible at all.
 *   Bumping the board's epoch changes this message for every token that board
 *   ever issued, so all of them fail as `bad-signature` — and *only* that
 *   board's, because the id is in the same message. No key rotation, no
 *   deployment-wide sign-out, no ledger of revoked tokens to keep.
 *
 * The epoch covers the **pairing token as well as the grant**, deliberately.
 * Leaving it out of the pairing token would leave a residual hole exactly as
 * long as `DEFAULT_PAIRING_TTL_SECONDS`: a QR photographed a minute before the
 * owner hit revoke would still be redeemable afterwards, and the grant it minted
 * would be issued at the *new* epoch — i.e. a revoked controller could walk
 * straight back in. Both mint sites already hold the board row (the TV's loader
 * reads it to prove ownership; `pair` reads it to authorise), so the epoch costs
 * nothing there. The price is that a revoke also kills the code currently on the
 * TV — which self-heals on the display's next re-mint tick (`QR_REFRESH_MS`, a
 * third of the TTL) and is, for "kick everyone off my board", the answer the
 * owner actually wants.
 *
 * The epoch is a non-negative integer, so its decimal form contains no `|` and
 * needs no length framing to stay injective.
 */
const signingMessage = (
  prefix: string,
  boardId: string,
  grantEpoch: number,
  payload: string
): string => `${prefix}|${boardId.length}|${boardId}|${grantEpoch}|${payload}`;

/**
 * A secret is required for both minting and verifying. Absent, every token
 * would verify against a key of zero length — fail loudly instead, as a
 * configuration fault rather than a token verdict.
 */
const requireSecret = (
  secret: string
): Effect.Effect<string, ConfigurationError> =>
  typeof secret === "string" && secret.length > 0
    ? Effect.succeed(secret)
    : Effect.fail(
        new ConfigurationError({ service: "Pairing", field: "secret" })
      );

/**
 * HMAC-SHA256 via `crypto.subtle` — WebCrypto, never `node:crypto`, because
 * this runs on Workers. Key import happens per call: keys are cheap, and a
 * cached `CryptoKey` would have to be keyed by secret, which is exactly the
 * thing not worth keeping in a module-level map.
 */
const hmac = (
  secret: string,
  message: string
): Effect.Effect<Uint8Array, ConfigurationError> =>
  Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "raw",
        textEncoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const signature = await crypto.subtle.sign(
        "HMAC",
        key,
        textEncoder.encode(message)
      );
      return new Uint8Array(signature);
    },
    // WebCrypto refusing to import an HMAC key or sign with it is an
    // environment fault (no `crypto.subtle`, unusable secret), never something
    // the presented token can cause. It belongs in the error channel, not in
    // the verdict union.
    catch: () => new ConfigurationError({ service: "Pairing", field: "webcrypto" }),
  });

/**
 * Constant-time byte comparison.
 *
 * The obvious `for (…) if (a[i] !== b[i]) return false` leaks: it returns as
 * soon as it finds a differing byte, so how long a verification takes is
 * proportional to how many leading bytes the attacker got right. Given enough
 * timed attempts that turns forging a 32-byte MAC from 2^256 work into ~32×256
 * work, one byte at a time.
 *
 * So: OR every byte difference into an accumulator, always walk the full
 * length, and compare once at the end. Length mismatch is folded into the same
 * accumulator (the length of a signature is not a secret — it is fixed by
 * SHA-256 — so branching on it would be safe, but there is no reason to).
 */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
};

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

interface TokenStructure {
  readonly payload: string;
  readonly signature: Uint8Array;
}

/**
 * Split and shape-check a token without consulting the key. Everything here is
 * attacker-controlled and cheap to reject, which is exactly why it runs before
 * any crypto: a malformed string never reaches `crypto.subtle`.
 */
const parseStructure = (prefix: string, token: string): TokenStructure | null => {
  if (typeof token !== "string") return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;

  const segments = token.split(".");
  if (segments.length !== SEGMENT_COUNT) return null;

  const [tokenPrefix, payload, signature] = segments as [string, string, string];
  // A grant presented where a pairing token is expected lands here: wrong
  // purpose, so "malformed" — the key is never even consulted.
  if (tokenPrefix !== prefix) return null;
  if (!BASE64URL.test(payload)) return null;

  const signatureBytes = base64UrlToBytes(signature);
  if (signatureBytes === null) return null;

  return { payload, signature: signatureBytes };
};

/* -------------------------------------------------------------------------- */
/* Mint / verify                                                              */
/* -------------------------------------------------------------------------- */

const randomNonce = (): string =>
  bytesToBase64Url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));

const normalizeTtl = (ttlSeconds: number, fallback: number): number => {
  if (!Number.isFinite(ttlSeconds)) return fallback;
  const floored = Math.floor(ttlSeconds);
  return floored > 0 ? floored : fallback;
};

const mintToken = (
  prefix: string,
  defaultTtlSeconds: number,
  input: MintTokenInput
): Effect.Effect<string, ConfigurationError> =>
  Effect.gen(function* () {
    const secret = yield* requireSecret(input.secret);
    const issuedAt = Math.floor(input.now);
    const ttlSeconds = normalizeTtl(
      input.ttlSeconds ?? defaultTtlSeconds,
      defaultTtlSeconds
    );
    const claims: PairingClaims = {
      boardId: input.boardId,
      issuedAt,
      expiresAt: issuedAt + ttlSeconds * 1000,
      nonce: input.nonce ?? randomNonce(),
    };
    const payload = encodePayload(claims);
    const signature = yield* hmac(
      secret,
      signingMessage(prefix, input.boardId, input.grantEpoch, payload)
    );
    return `${prefix}.${payload}.${bytesToBase64Url(signature)}`;
  });

const verifyToken = (
  prefix: string,
  input: VerifyTokenInput
): Effect.Effect<TokenVerification, ConfigurationError> =>
  Effect.gen(function* () {
    const secret = yield* requireSecret(input.secret);

    const structure = parseStructure(prefix, input.token);
    if (structure === null) return malformed;

    // Authenticity first. Nothing inside the payload is trusted — not even
    // enough to say "expired" — until the MAC over
    // (prefix, boardId, grantEpoch, payload) matches, so a forged token can never
    // provoke a payload-shaped answer. A revoked token lands here as
    // `bad-signature`, indistinguishable from a forgery, which is correct: it is
    // no longer a token we would have issued.
    const expectedSignature = yield* hmac(
      secret,
      signingMessage(prefix, input.boardId, input.grantEpoch, structure.payload)
    );
    if (!timingSafeEqual(expectedSignature, structure.signature)) {
      return badSignature;
    }

    const claims = decodeClaims(structure.payload);
    if (claims === null) return malformed;
    // Defence in depth: the id is already bound into the MAC above, so this can
    // only fire if the signing message ever stops framing the board id.
    if (claims.boardId !== input.boardId) return badSignature;
    // `>=` not `>`: a token is dead the instant it reaches its expiry.
    if (input.now >= claims.expiresAt) return expired;

    return {
      ok: true,
      nonce: claims.nonce,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    };
  });

/** Mint the short-lived, single-use token the TV prints as a QR. */
export const mintPairingToken = (
  input: MintTokenInput
): Effect.Effect<string, ConfigurationError> =>
  mintToken(PAIRING_PREFIX, DEFAULT_PAIRING_TTL_SECONDS, input);

/**
 * Verify a pairing token. The returned `nonce` is what the caller must record as
 * spent — this module deliberately keeps no state, so single-use is enforced one
 * layer up, where there is somewhere durable to write.
 */
export const verifyPairingToken = (
  input: VerifyTokenInput
): Effect.Effect<TokenVerification, ConfigurationError> =>
  verifyToken(PAIRING_PREFIX, input);

/** Mint the cookie-borne grant that authorises writes to one board. */
export const mintControllerGrant = (
  input: MintTokenInput
): Effect.Effect<string, ConfigurationError> =>
  mintToken(GRANT_PREFIX, DEFAULT_GRANT_TTL_SECONDS, input);

export const verifyControllerGrant = (
  input: VerifyTokenInput
): Effect.Effect<TokenVerification, ConfigurationError> =>
  verifyToken(GRANT_PREFIX, input);

/* -------------------------------------------------------------------------- */
/* Grant cookie                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One cookie per board, so holding a grant for one board says nothing about
 * another and revoking one cannot revoke the rest.
 *
 * A board id is a bounded string, not a cookie token, so anything outside the
 * cookie-name charset is folded to `_`. Two different ids *can* therefore map to
 * the same cookie name — which is harmless: the grant inside is MAC-bound to the
 * real board id, so a collided cookie simply fails to verify. The name is a
 * lookup key, never an authorisation decision.
 */
export const grantCookieName = (boardId: string): string =>
  `${GRANT_COOKIE_PREFIX}${boardId.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export interface GrantCookieInput {
  readonly boardId: string;
  readonly token: string;
  readonly maxAgeSeconds: number;
  /** True on https. Off in local http dev, or the browser drops the cookie. */
  readonly secure: boolean;
}

/**
 * `HttpOnly` (script must never read a grant), `SameSite=Lax` (the phone arrives
 * by a top-level navigation from a QR scan, which Lax allows, while a
 * cross-site POST cannot ride the grant), `Secure` in production.
 *
 * `Path=/` is deliberate, not laziness: the phone's writes go to `/api/trpc`,
 * not to `/b/:boardId/c`, so a board-scoped path would send the cookie to the
 * page and withhold it from every mutation. Scoping is achieved by the two
 * mechanisms that actually bind: a per-board cookie *name*, and a board id
 * inside the signed token.
 */
export const serializeGrantCookie = (input: GrantCookieInput): string =>
  [
    `${grantCookieName(input.boardId)}=${input.token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(input.maxAgeSeconds))}`,
    ...(input.secure ? ["Secure"] : []),
  ].join("; ");

/** Same name/path/flags with a zero lifetime — anything else leaves the cookie in place. */
export const clearGrantCookie = (boardId: string, secure: boolean): string =>
  [
    `${grantCookieName(boardId)}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

/**
 * **Every** grant this header carries for this board, in the order the browser
 * sent them. Empty when there are none.
 *
 * Plural, and that is the point. A `Cookie` header can legitimately contain the
 * same name twice, because cookie *scope* is not part of a request: a cookie set
 * on `.workers.dev` (a sibling worker on the same account) or on a parent of a
 * custom domain (any sibling subdomain) arrives alongside our own host-set one,
 * under the same name, and the browser gives no hint which is which. Returning
 * only the first match handed any such neighbour a denial-of-service on pairing:
 * inject `fb_grant_<id>=junk`, the real grant is never examined, verification
 * fails, and the controller route then bins the genuine cookie.
 *
 * So this returns candidates and `verifyControllerGrants` accepts if **any** of
 * them verifies. That is not a weakening: each candidate still has to carry a
 * valid MAC over (prefix, board id, current epoch, payload), so an injected
 * cookie can only ever be noise, never a credential.
 */
export const readGrantCookies = (
  header: string | null | undefined,
  boardId: string
): ReadonlyArray<string> => {
  if (typeof header !== "string" || header.length === 0) return [];
  const wanted = grantCookieName(boardId);
  const found: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== wanted) continue;
    const value = part.slice(separator + 1).trim();
    // A name-only or empty-valued cookie is not a candidate — it cannot verify,
    // and keeping it would only make "the caller presented something" true when
    // the caller presented nothing.
    if (value.length > 0) found.push(value);
  }
  return found;
};

/** Refusals, worst-to-best. A more specific reason makes a better log line. */
const REFUSAL_RANK: Record<PairingFailureReason, number> = {
  malformed: 0,
  "bad-signature": 1,
  expired: 2,
};

export interface VerifyGrantsInput {
  /** Candidates from `readGrantCookies`. Bounded by the header size. */
  readonly tokens: ReadonlyArray<string>;
  readonly boardId: string;
  readonly grantEpoch: number;
  readonly secret: string;
  readonly now: number;
}

/**
 * Verify a set of grant candidates for one board: **ok if any single one holds
 * up**, otherwise the most specific refusal any of them produced.
 *
 * Every candidate is checked — no early exit on the first refusal — so a
 * neighbour-injected cookie cannot mask the genuine one (see
 * `readGrantCookies`). An empty list is `malformed`; callers that need to
 * distinguish "presented nothing" from "presented junk" must check the list
 * length themselves, because those two cases have deliberately different
 * observable answers at the route layer.
 */
export const verifyControllerGrants = (
  input: VerifyGrantsInput
): Effect.Effect<TokenVerification, ConfigurationError> =>
  Effect.gen(function* () {
    let worst: TokenVerification = malformed;
    for (const token of input.tokens) {
      const verdict = yield* verifyControllerGrant({
        token,
        boardId: input.boardId,
        grantEpoch: input.grantEpoch,
        secret: input.secret,
        now: input.now,
      });
      if (verdict.ok) return verdict;
      if (worst.ok) continue;
      if (REFUSAL_RANK[verdict.reason] > REFUSAL_RANK[worst.reason]) {
        worst = verdict;
      }
    }
    return worst;
  });

/* -------------------------------------------------------------------------- */
/* What a grant is allowed to look back at                                    */
/* -------------------------------------------------------------------------- */

/**
 * The lower bound (epoch ms) on board history a caller may read, or `undefined`
 * for no bound.
 *
 * An owner reads everything — it is their board. A grant reads only what the
 * board has shown **since the grant was issued**. A phone that scanned tonight is
 * authorised to drive the board, which is not the same as being authorised to
 * read back the hundred most recent grids *and their prompts* — the text the
 * owner dictated before the guest arrived. The grant's own `issuedAt` is already
 * returned by `verifyControllerGrant`, so the bound is free and cannot be
 * influenced by the caller.
 */
export const grantHistoryFloor = (access: {
  readonly via: "owner" | "grant";
  readonly grantIssuedAt: number | null;
}): number | undefined =>
  access.via === "grant" && access.grantIssuedAt !== null
    ? access.grantIssuedAt
    : undefined;
