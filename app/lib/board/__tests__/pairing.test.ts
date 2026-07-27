import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import {
  DEFAULT_PAIRING_TTL_SECONDS,
  GRANT_COOKIE_PREFIX,
  GRANT_PREFIX,
  MAX_TOKEN_LENGTH,
  PAIRING_PREFIX,
  bytesToBase64Url,
  base64UrlToBytes,
  clearGrantCookie,
  decodeClaims,
  grantCookieName,
  mintControllerGrant,
  mintPairingToken,
  grantHistoryFloor,
  readGrantCookies,
  serializeGrantCookie,
  timingSafeEqual,
  verifyControllerGrant,
  verifyControllerGrants,
  verifyPairingToken,
  type TokenVerification,
} from "../pairing";

const SECRET = "test-secret-not-a-real-better-auth-secret";
const OTHER_SECRET = "a-different-secret-entirely";
const BOARD = "board-aaaa-bbbb-cccc";
const NOW = 1_700_000_000_000;
/** The board's `grantEpoch` for every test that is not about revocation. */
const EPOCH = 0;

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(effect);

const mint = (overrides: Partial<Parameters<typeof mintPairingToken>[0]> = {}) =>
  run(
    mintPairingToken({
      boardId: BOARD,
      grantEpoch: EPOCH,
      secret: SECRET,
      now: NOW,
      ...overrides,
    })
  );

const verify = (
  overrides: Partial<Parameters<typeof verifyPairingToken>[0]> & { token: string }
) =>
  run(
    verifyPairingToken({
      boardId: BOARD,
      grantEpoch: EPOCH,
      secret: SECRET,
      now: NOW,
      ...overrides,
    })
  );

/** Narrowing helper — keeps every assertion below free of `as` casts. */
const expectRefused = (
  verdict: TokenVerification,
  reason: "malformed" | "bad-signature" | "expired"
) => {
  expect(verdict.ok).toBe(false);
  if (!verdict.ok) expect(verdict.reason).toBe(reason);
};

describe("base64url encoding", () => {
  it("round-trips arbitrary bytes with no padding and no url-hostile characters", () => {
    for (let length = 1; length <= 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + length) % 256;
      const encoded = bytesToBase64Url(bytes);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(base64UrlToBytes(encoded)).toEqual(bytes);
    }
  });

  it("rejects non-base64url input instead of throwing", () => {
    expect(base64UrlToBytes("")).toBeNull();
    expect(base64UrlToBytes("has spaces")).toBeNull();
    expect(base64UrlToBytes("plus+slash/")).toBeNull();
    expect(base64UrlToBytes("padded==")).toBeNull();
  });
});

describe("timingSafeEqual", () => {
  it("is true only for identical byte sequences", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(
      true
    );
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(
      false
    );
    // Differs in the first byte only — must still be false, and must have
    // examined the whole array rather than bailing out early.
    expect(timingSafeEqual(new Uint8Array([9, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(
      false
    );
  });

  it("is false for differing lengths, including a prefix match", () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(
      false
    );
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([0]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

describe("mintPairingToken", () => {
  it("produces a prefix.payload.signature token", async () => {
    const token = await mint();
    const segments = token.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe(PAIRING_PREFIX);
    expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
  });

  it("uses a fresh nonce for two mints with identical inputs", async () => {
    const first = await mint();
    const second = await mint();
    expect(first).not.toBe(second);

    const firstClaims = decodeClaims(first.split(".")[1]!);
    const secondClaims = decodeClaims(second.split(".")[1]!);
    expect(firstClaims).not.toBeNull();
    expect(secondClaims).not.toBeNull();
    expect(firstClaims?.nonce).not.toBe(secondClaims?.nonce);
    // Everything else is identical, so the nonce is the only source of the
    // difference — which is what makes the single-use ledger meaningful.
    expect(firstClaims?.issuedAt).toBe(secondClaims?.issuedAt);
    expect(firstClaims?.expiresAt).toBe(secondClaims?.expiresAt);
  });

  it("defaults to the ~120s TTL and honours an override", async () => {
    const defaulted = decodeClaims((await mint()).split(".")[1]!);
    expect(defaulted?.expiresAt).toBe(NOW + DEFAULT_PAIRING_TTL_SECONDS * 1000);

    const custom = decodeClaims((await mint({ ttlSeconds: 5 })).split(".")[1]!);
    expect(custom?.expiresAt).toBe(NOW + 5_000);
  });

  it("falls back to the default TTL for a nonsensical one", async () => {
    const zero = decodeClaims((await mint({ ttlSeconds: 0 })).split(".")[1]!);
    const negative = decodeClaims((await mint({ ttlSeconds: -60 })).split(".")[1]!);
    const nan = decodeClaims((await mint({ ttlSeconds: Number.NaN })).split(".")[1]!);
    const expected = NOW + DEFAULT_PAIRING_TTL_SECONDS * 1000;
    expect(zero?.expiresAt).toBe(expected);
    expect(negative?.expiresAt).toBe(expected);
    expect(nan?.expiresAt).toBe(expected);
  });

  it("fails as a configuration fault when there is no secret", async () => {
    const exit = await Effect.runPromiseExit(
      mintPairingToken({ boardId: BOARD, grantEpoch: EPOCH, secret: "", now: NOW })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("verifyPairingToken", () => {
  it("accepts a freshly minted token and exposes its nonce and expiry", async () => {
    const token = await mint();
    const verdict = await verify({ token });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.nonce.length).toBeGreaterThan(0);
      expect(verdict.issuedAt).toBe(NOW);
      expect(verdict.expiresAt).toBe(NOW + DEFAULT_PAIRING_TTL_SECONDS * 1000);
    }
  });

  it("accepts the token right up to, but not at, its expiry", async () => {
    const token = await mint({ ttlSeconds: 10 });
    expectRefused(await verify({ token, now: NOW + 10_000 }), "expired");
    expect((await verify({ token, now: NOW + 9_999 })).ok).toBe(true);
  });

  it("rejects an expired token", async () => {
    const token = await mint({ ttlSeconds: 30 });
    expectRefused(await verify({ token, now: NOW + 31_000 }), "expired");
  });

  it("rejects a token whose payload was edited", async () => {
    // Re-encode the claims with a far-future expiry, keeping the signature —
    // exactly what an attacker who wants an immortal QR would try.
    const token = await mint();
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const claims = decodeClaims(payload);
    expect(claims).not.toBeNull();
    const forged = bytesToBase64Url(
      new TextEncoder().encode(
        JSON.stringify({
          b: claims!.boardId,
          i: claims!.issuedAt,
          e: claims!.expiresAt + 10_000_000,
          n: claims!.nonce,
        })
      )
    );
    expect(forged).not.toBe(payload);
    expectRefused(
      await verify({ token: `${prefix}.${forged}.${signature}` }),
      "bad-signature"
    );
  });

  it("rejects a token whose signature was edited", async () => {
    const token = await mint();
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const flipped =
      (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expectRefused(await verify({ token: `${prefix}.${payload}.${flipped}` }), "bad-signature");
  });

  it("rejects a token for board A when presented for board B", async () => {
    const token = await run(
      mintPairingToken({ boardId: "board-a", grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    expectRefused(await verify({ token, boardId: "board-b" }), "bad-signature");
    // Sanity: it is a perfectly good token for the board it was minted for.
    expect((await verify({ token, boardId: "board-a" })).ok).toBe(true);
  });

  it("rejects a token signed with a different secret", async () => {
    const token = await run(
      mintPairingToken({ boardId: BOARD, grantEpoch: EPOCH, secret: OTHER_SECRET, now: NOW })
    );
    expectRefused(await verify({ token }), "bad-signature");
  });

  it("rejects garbage, empty input and wrong segment counts as malformed", async () => {
    expectRefused(await verify({ token: "" }), "malformed");
    expectRefused(await verify({ token: "not-a-token" }), "malformed");
    expectRefused(await verify({ token: "a.b" }), "malformed");
    expectRefused(await verify({ token: "a.b.c.d" }), "malformed");
    expectRefused(await verify({ token: `${PAIRING_PREFIX}..` }), "malformed");
    expectRefused(
      await verify({ token: `${PAIRING_PREFIX}.payload with spaces.sig` }),
      "malformed"
    );
    expectRefused(
      await verify({ token: `x${"y".repeat(MAX_TOKEN_LENGTH)}` }),
      "malformed"
    );
  });

  it("rejects a token whose prefix says it is something else", async () => {
    const token = await mint();
    const swapped = `${GRANT_PREFIX}${token.slice(PAIRING_PREFIX.length)}`;
    expectRefused(await verify({ token: swapped }), "malformed");
  });

  it("fails as a configuration fault when there is no secret", async () => {
    const token = await mint();
    const exit = await Effect.runPromiseExit(
      verifyPairingToken({ token, boardId: BOARD, grantEpoch: EPOCH, secret: "", now: NOW })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("controller grants", () => {
  it("round-trips independently of the pairing token", async () => {
    const grant = await run(
      mintControllerGrant({ boardId: BOARD, grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    const verdict = await run(
      verifyControllerGrant({
        token: grant,
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
      })
    );
    expect(verdict.ok).toBe(true);
    expect(grant.split(".")[0]).toBe(GRANT_PREFIX);
  });

  it("cannot be presented as a pairing token, nor a pairing token as a grant", async () => {
    const grant = await run(
      mintControllerGrant({ boardId: BOARD, grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    const pairing = await mint();

    expectRefused(await verify({ token: grant }), "malformed");
    expectRefused(
      await run(
        verifyControllerGrant({
          token: pairing,
          boardId: BOARD,
          grantEpoch: EPOCH,
          secret: SECRET,
          now: NOW,
        })
      ),
      "malformed"
    );
  });

  it("is board-scoped and expires", async () => {
    const grant = await run(
      mintControllerGrant({
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
        ttlSeconds: 60,
      })
    );
    expectRefused(
      await run(
        verifyControllerGrant({
          token: grant,
          boardId: "another-board",
          grantEpoch: EPOCH,
          secret: SECRET,
          now: NOW,
        })
      ),
      "bad-signature"
    );
    expectRefused(
      await run(
        verifyControllerGrant({
          token: grant,
          boardId: BOARD,
          grantEpoch: EPOCH,
          secret: SECRET,
          now: NOW + 60_001,
        })
      ),
      "expired"
    );
  });
});

describe("decodeClaims", () => {
  it("rejects payloads that are not well-formed claims", () => {
    const encode = (value: unknown) =>
      bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));

    expect(decodeClaims("!!!")).toBeNull();
    expect(decodeClaims(encode("a string"))).toBeNull();
    expect(decodeClaims(encode([1, 2, 3]))).toBeNull();
    expect(decodeClaims(encode({ b: "", i: NOW, e: NOW + 1, n: "n" }))).toBeNull();
    expect(decodeClaims(encode({ b: "x", i: NOW, e: NOW + 1, n: "" }))).toBeNull();
    expect(decodeClaims(encode({ b: "x", i: 1.5, e: NOW, n: "n" }))).toBeNull();
    expect(decodeClaims(encode({ b: "x", i: NOW, e: "later", n: "n" }))).toBeNull();
    // Expiry at or before issue is nonsense, not merely stale.
    expect(decodeClaims(encode({ b: "x", i: NOW, e: NOW, n: "n" }))).toBeNull();
    expect(decodeClaims(encode({ b: "x", i: NOW, e: NOW + 1, n: "n" }))).toEqual({
      boardId: "x",
      issuedAt: NOW,
      expiresAt: NOW + 1,
      nonce: "n",
    });
  });
});

describe("grant cookie", () => {
  it("names one cookie per board", () => {
    expect(grantCookieName(BOARD)).toBe(`${GRANT_COOKIE_PREFIX}${BOARD}`);
    expect(grantCookieName("a b.c")).toBe(`${GRANT_COOKIE_PREFIX}a_b_c`);
  });

  it("serializes an httpOnly, lax, path-wide cookie and marks it secure on https", () => {
    const insecure = serializeGrantCookie({
      boardId: BOARD,
      token: "tok",
      maxAgeSeconds: 3600,
      secure: false,
    });
    expect(insecure).toContain(`${GRANT_COOKIE_PREFIX}${BOARD}=tok`);
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).toContain("Path=/");
    expect(insecure).toContain("Max-Age=3600");
    expect(insecure).not.toContain("Secure");

    const secure = serializeGrantCookie({
      boardId: BOARD,
      token: "tok",
      maxAgeSeconds: 3600,
      secure: true,
    });
    expect(secure).toContain("Secure");
  });

  it("clamps a negative or fractional max-age", () => {
    expect(
      serializeGrantCookie({
        boardId: BOARD,
        token: "t",
        maxAgeSeconds: -5,
        secure: false,
      })
    ).toContain("Max-Age=0");
    expect(
      serializeGrantCookie({
        boardId: BOARD,
        token: "t",
        maxAgeSeconds: 10.9,
        secure: false,
      })
    ).toContain("Max-Age=10");
  });

  it("clears with a zero lifetime on the same name and path", () => {
    const cleared = clearGrantCookie(BOARD, true);
    expect(cleared).toContain(`${GRANT_COOKIE_PREFIX}${BOARD}=`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("Secure");
  });

  it("reads only this board's grant out of a cookie header", () => {
    const header = `theme=dark; ${GRANT_COOKIE_PREFIX}${BOARD}=abc.def.ghi; ${GRANT_COOKIE_PREFIX}other=zzz`;
    expect(readGrantCookies(header, BOARD)).toEqual(["abc.def.ghi"]);
    expect(readGrantCookies(header, "other")).toEqual(["zzz"]);
    expect(readGrantCookies(header, "absent")).toEqual([]);
  });

  it("returns every cookie with this board's name, in the order sent", () => {
    // A sibling host on a parent domain can set the same name; the browser sends
    // both and gives no hint which is which.
    const header = `${GRANT_COOKIE_PREFIX}${BOARD}=injected; theme=dark; ${GRANT_COOKIE_PREFIX}${BOARD}=genuine`;
    expect(readGrantCookies(header, BOARD)).toEqual(["injected", "genuine"]);
  });

  it("returns nothing for absent, empty and malformed cookie headers", () => {
    expect(readGrantCookies(null, BOARD)).toEqual([]);
    expect(readGrantCookies(undefined, BOARD)).toEqual([]);
    expect(readGrantCookies("", BOARD)).toEqual([]);
    expect(readGrantCookies("garbage", BOARD)).toEqual([]);
    expect(readGrantCookies(`${GRANT_COOKIE_PREFIX}${BOARD}=`, BOARD)).toEqual([]);
    expect(readGrantCookies(`=${GRANT_COOKIE_PREFIX}${BOARD}`, BOARD)).toEqual([]);
  });

  it("round-trips a real grant through serialize → read → verify", async () => {
    const grant = await run(
      mintControllerGrant({ boardId: BOARD, grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    const setCookie = serializeGrantCookie({
      boardId: BOARD,
      token: grant,
      maxAgeSeconds: 60,
      secure: true,
    });
    // Browsers send back only `name=value`, so that is what is parsed here.
    const sent = setCookie.split(";")[0]!;
    const read = readGrantCookies(sent, BOARD)[0] ?? null;
    expect(read).toBe(grant);
    const verdict = await run(
      verifyControllerGrant({
        token: read!,
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
      })
    );
    expect(verdict.ok).toBe(true);
  });
});

describe("grant epoch — revocation", () => {
  const grantAt = (epoch: number, boardId = BOARD) =>
    run(
      mintControllerGrant({ boardId, grantEpoch: epoch, secret: SECRET, now: NOW })
    );

  const verifyAt = (token: string, epoch: number, boardId = BOARD) =>
    run(
      verifyControllerGrant({
        token,
        boardId,
        grantEpoch: epoch,
        secret: SECRET,
        now: NOW,
      })
    );

  it("a grant minted at epoch N still verifies at epoch N", async () => {
    expect((await verifyAt(await grantAt(7), 7)).ok).toBe(true);
  });

  it("a grant minted at epoch N fails at epoch N+1", async () => {
    // Indistinguishable from a forgery, which is the point: it is no longer a
    // token we would have issued.
    expectRefused(await verifyAt(await grantAt(7), 8), "bad-signature");
  });

  it("every earlier epoch stays dead, not just the previous one", async () => {
    const grant = await grantAt(0);
    for (const epoch of [1, 2, 3, 50]) {
      expectRefused(await verifyAt(grant, epoch), "bad-signature");
    }
  });

  it("bumping board A does not affect a grant for board B", async () => {
    const forB = await grantAt(0, "board-b");
    // Board A is now at epoch 1; B never moved.
    expect((await verifyAt(forB, 0, "board-b")).ok).toBe(true);
    expectRefused(await verifyAt(forB, 1, "board-b"), "bad-signature");
  });

  it("covers the pairing token too, so revoking kills the QR on screen", async () => {
    const token = await mint({ grantEpoch: 4 });
    expect((await verify({ token, grantEpoch: 4 })).ok).toBe(true);
    expectRefused(await verify({ token, grantEpoch: 5 }), "bad-signature");
  });

  it("does not let a grant epoch stand in for a board id, or vice versa", async () => {
    // The message is `prefix|len|boardId|epoch|payload`, so no pair of
    // (boardId, epoch) values can collide into the same message.
    const grant = await grantAt(1, "ab");
    expectRefused(await verifyAt(grant, 1, "a"), "bad-signature");
    expectRefused(await verifyAt(grant, 11, "ab"), "bad-signature");
  });
});

describe("verifyControllerGrants — many cookies, one name", () => {
  const verifyMany = (tokens: ReadonlyArray<string>, grantEpoch = EPOCH) =>
    run(
      verifyControllerGrants({
        tokens,
        boardId: BOARD,
        grantEpoch,
        secret: SECRET,
        now: NOW,
      })
    );

  it("accepts when the *second* cookie is the valid one", async () => {
    // The exact injection this exists for: a sibling host sets
    // `fb_grant_<id>=junk` on a parent domain, the browser sends it first, and
    // taking only the first match refused a caller who holds a genuine grant.
    const genuine = await run(
      mintControllerGrant({
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
      })
    );
    const verdict = await verifyMany(["junk", genuine]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.issuedAt).toBe(NOW);
  });

  it("accepts when the valid one is first, or the only one", async () => {
    const genuine = await run(
      mintControllerGrant({
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
      })
    );
    expect((await verifyMany([genuine, "junk"])).ok).toBe(true);
    expect((await verifyMany([genuine])).ok).toBe(true);
  });

  it("refuses when none verify, reporting the most specific reason", async () => {
    const stale = await run(
      mintControllerGrant({
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
        ttlSeconds: 60,
      })
    );
    const later = run(
      verifyControllerGrants({
        tokens: ["junk", stale],
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW + 60_001,
      })
    );
    // `expired` outranks the `malformed` from "junk" — a better log line, and
    // still one generic UNAUTHORIZED for the client.
    expectRefused(await later, "expired");
  });

  it("refuses an empty list as malformed", async () => {
    expectRefused(await verifyMany([]), "malformed");
  });

  it("does not let a revoked grant sneak in beside a fresh one", async () => {
    const revoked = await run(
      mintControllerGrant({
        boardId: BOARD,
        grantEpoch: 0,
        secret: SECRET,
        now: NOW,
      })
    );
    expectRefused(await verifyMany([revoked, revoked], 1), "bad-signature");
  });
});

describe("grantHistoryFloor", () => {
  it("bounds a grant to its own issue time", () => {
    expect(grantHistoryFloor({ via: "grant", grantIssuedAt: NOW })).toBe(NOW);
  });

  it("leaves an owner unbounded", () => {
    expect(grantHistoryFloor({ via: "owner", grantIssuedAt: null })).toBeUndefined();
    // An owner session carries no issue time, but even if one leaked in it must
    // not narrow what the owner can read.
    expect(grantHistoryFloor({ via: "owner", grantIssuedAt: NOW })).toBeUndefined();
  });

  it("leaves a grant with no issue time unbounded rather than guessing one", () => {
    expect(
      grantHistoryFloor({ via: "grant", grantIssuedAt: null })
    ).toBeUndefined();
  });
});
