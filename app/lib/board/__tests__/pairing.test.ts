import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import {
  DEFAULT_DEVICE_TTL_SECONDS,
  DEFAULT_GRANT_TTL_SECONDS,
  DEFAULT_HANDOFF_TTL_SECONDS,
  DEFAULT_PAIRING_TTL_SECONDS,
  DEVICE_COOKIE_PREFIX,
  DEVICE_PREFIX,
  GRANT_COOKIE_PREFIX,
  GRANT_PREFIX,
  HANDOFF_PREFIX,
  MAX_TOKEN_LENGTH,
  PAIRING_PREFIX,
  bytesToBase64Url,
  base64UrlToBytes,
  clearDeviceCookie,
  clearGrantCookie,
  decodeClaims,
  deviceCookieName,
  grantCookieName,
  mintControllerGrant,
  mintDeviceGrant,
  mintHandoffToken,
  mintPairingToken,
  grantHistoryFloor,
  readDeviceCookies,
  readGrantCookies,
  serializeDeviceCookie,
  serializeGrantCookie,
  timingSafeEqual,
  verifyControllerGrant,
  verifyControllerGrants,
  verifyDeviceGrant,
  verifyDeviceGrants,
  verifyHandoffToken,
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

const mintDevice = (
  overrides: Partial<Parameters<typeof mintDeviceGrant>[0]> = {}
) =>
  run(
    mintDeviceGrant({
      boardId: BOARD,
      deviceEpoch: EPOCH,
      secret: SECRET,
      now: NOW,
      ...overrides,
    })
  );

const verifyDevice = (
  overrides: Partial<Parameters<typeof verifyDeviceGrant>[0]> & { token: string }
) =>
  run(
    verifyDeviceGrant({
      boardId: BOARD,
      deviceEpoch: EPOCH,
      secret: SECRET,
      now: NOW,
      ...overrides,
    })
  );

const mintHandoff = (
  overrides: Partial<Parameters<typeof mintHandoffToken>[0]> = {}
) =>
  run(
    mintHandoffToken({
      boardId: BOARD,
      deviceEpoch: EPOCH,
      secret: SECRET,
      now: NOW,
      ...overrides,
    })
  );

const verifyHandoff = (
  overrides: Partial<Parameters<typeof verifyHandoffToken>[0]> & {
    token: string;
  }
) =>
  run(
    verifyHandoffToken({
      boardId: BOARD,
      deviceEpoch: EPOCH,
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

  it("defaults to the 30-day TTL and honours an override", async () => {
    // 30 days, not the original 12h: the phone stays the remote across a week
    // of ordinary use without re-scanning the QR.
    expect(DEFAULT_GRANT_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
    const grant = await run(
      mintControllerGrant({ boardId: BOARD, grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    expect(decodeClaims(grant.split(".")[1]!)?.expiresAt).toBe(
      NOW + DEFAULT_GRANT_TTL_SECONDS * 1000
    );

    const custom = await run(
      mintControllerGrant({
        boardId: BOARD,
        grantEpoch: EPOCH,
        secret: SECRET,
        now: NOW,
        ttlSeconds: 5,
      })
    );
    expect(decodeClaims(custom.split(".")[1]!)?.expiresAt).toBe(NOW + 5_000);
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

describe("mintDeviceGrant", () => {
  it("produces a prefix.payload.signature token", async () => {
    const token = await mintDevice();
    const segments = token.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe(DEVICE_PREFIX);
    expect(token.length).toBeLessThanOrEqual(MAX_TOKEN_LENGTH);
  });

  it("uses a fresh nonce for two mints with identical inputs", async () => {
    const first = await mintDevice();
    const second = await mintDevice();
    expect(first).not.toBe(second);

    const firstClaims = decodeClaims(first.split(".")[1]!);
    const secondClaims = decodeClaims(second.split(".")[1]!);
    expect(firstClaims).not.toBeNull();
    expect(secondClaims).not.toBeNull();
    expect(firstClaims?.nonce).not.toBe(secondClaims?.nonce);
    expect(firstClaims?.issuedAt).toBe(secondClaims?.issuedAt);
    expect(firstClaims?.expiresAt).toBe(secondClaims?.expiresAt);
  });

  it("defaults to the 180-day TTL and honours an override", async () => {
    // Longer than a controller grant on purpose: the TV's cookie should be
    // evicted by the browser before it is ever allowed to expire.
    expect(DEFAULT_DEVICE_TTL_SECONDS).toBe(180 * 24 * 60 * 60);
    const defaulted = decodeClaims((await mintDevice()).split(".")[1]!);
    expect(defaulted?.expiresAt).toBe(NOW + DEFAULT_DEVICE_TTL_SECONDS * 1000);

    const custom = decodeClaims((await mintDevice({ ttlSeconds: 5 })).split(".")[1]!);
    expect(custom?.expiresAt).toBe(NOW + 5_000);
  });

  it("falls back to the default TTL for a nonsensical one", async () => {
    const zero = decodeClaims((await mintDevice({ ttlSeconds: 0 })).split(".")[1]!);
    const negative = decodeClaims(
      (await mintDevice({ ttlSeconds: -60 })).split(".")[1]!
    );
    const nan = decodeClaims(
      (await mintDevice({ ttlSeconds: Number.NaN })).split(".")[1]!
    );
    const expected = NOW + DEFAULT_DEVICE_TTL_SECONDS * 1000;
    expect(zero?.expiresAt).toBe(expected);
    expect(negative?.expiresAt).toBe(expected);
    expect(nan?.expiresAt).toBe(expected);
  });

  it("fails as a configuration fault when there is no secret", async () => {
    const exit = await Effect.runPromiseExit(
      mintDeviceGrant({ boardId: BOARD, deviceEpoch: EPOCH, secret: "", now: NOW })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("verifyDeviceGrant", () => {
  it("accepts a freshly minted grant and exposes its nonce and expiry", async () => {
    const token = await mintDevice();
    const verdict = await verifyDevice({ token });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.nonce.length).toBeGreaterThan(0);
      expect(verdict.issuedAt).toBe(NOW);
      expect(verdict.expiresAt).toBe(NOW + DEFAULT_DEVICE_TTL_SECONDS * 1000);
    }
  });

  it("accepts the grant right up to, but not at, its expiry", async () => {
    const token = await mintDevice({ ttlSeconds: 10 });
    expectRefused(await verifyDevice({ token, now: NOW + 10_000 }), "expired");
    expect((await verifyDevice({ token, now: NOW + 9_999 })).ok).toBe(true);
  });

  it("rejects an expired grant", async () => {
    const token = await mintDevice({ ttlSeconds: 30 });
    expectRefused(await verifyDevice({ token, now: NOW + 31_000 }), "expired");
  });

  it("rejects a grant whose payload was edited", async () => {
    const token = await mintDevice({ ttlSeconds: 30 });
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
      await verifyDevice({ token: `${prefix}.${forged}.${signature}` }),
      "bad-signature"
    );
  });

  it("rejects a grant whose signature was edited", async () => {
    const token = await mintDevice();
    const [prefix, payload, signature] = token.split(".") as [
      string,
      string,
      string,
    ];
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expectRefused(
      await verifyDevice({ token: `${prefix}.${payload}.${flipped}` }),
      "bad-signature"
    );
  });

  it("rejects a grant for board A when presented for board B", async () => {
    const token = await mintDevice({ boardId: "board-a" });
    expectRefused(await verifyDevice({ token, boardId: "board-b" }), "bad-signature");
    // Sanity: it is a perfectly good grant for the board it was minted for.
    expect((await verifyDevice({ token, boardId: "board-a" })).ok).toBe(true);
  });

  it("rejects a grant signed with a different secret", async () => {
    const token = await mintDevice({ secret: OTHER_SECRET });
    expectRefused(await verifyDevice({ token }), "bad-signature");
  });

  it("rejects garbage, empty input and wrong segment counts as malformed", async () => {
    expectRefused(await verifyDevice({ token: "" }), "malformed");
    expectRefused(await verifyDevice({ token: "not-a-token" }), "malformed");
    expectRefused(await verifyDevice({ token: "a.b" }), "malformed");
    expectRefused(await verifyDevice({ token: "a.b.c.d" }), "malformed");
    expectRefused(await verifyDevice({ token: `${DEVICE_PREFIX}..` }), "malformed");
    expectRefused(
      await verifyDevice({ token: `${DEVICE_PREFIX}.payload with spaces.sig` }),
      "malformed"
    );
    expectRefused(
      await verifyDevice({ token: `x${"y".repeat(MAX_TOKEN_LENGTH)}` }),
      "malformed"
    );
  });

  it("rejects a grant whose prefix says it is something else", async () => {
    const token = await mintDevice();
    const swapped = `${GRANT_PREFIX}${token.slice(DEVICE_PREFIX.length)}`;
    expectRefused(await verifyDevice({ token: swapped }), "malformed");
  });

  it("fails as a configuration fault when there is no secret", async () => {
    const token = await mintDevice();
    const exit = await Effect.runPromiseExit(
      verifyDeviceGrant({
        token,
        boardId: BOARD,
        deviceEpoch: EPOCH,
        secret: "",
        now: NOW,
      })
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});

describe("handoff tokens", () => {
  it("round-trips and carries the ~120s TTL of a pairing token", async () => {
    expect(DEFAULT_HANDOFF_TTL_SECONDS).toBe(120);
    const token = await mintHandoff();
    expect(token.split(".")[0]).toBe(HANDOFF_PREFIX);
    const verdict = await verifyHandoff({ token });
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.nonce.length).toBeGreaterThan(0);
      expect(verdict.issuedAt).toBe(NOW);
      expect(verdict.expiresAt).toBe(NOW + DEFAULT_HANDOFF_TTL_SECONDS * 1000);
    }
  });

  it("accepts the token right up to, but not at, its expiry", async () => {
    const token = await mintHandoff({ ttlSeconds: 10 });
    expectRefused(await verifyHandoff({ token, now: NOW + 10_000 }), "expired");
    expect((await verifyHandoff({ token, now: NOW + 9_999 })).ok).toBe(true);
  });

  it("is board-scoped and key-bound", async () => {
    const token = await mintHandoff({ boardId: "board-a" });
    expectRefused(await verifyHandoff({ token, boardId: "board-b" }), "bad-signature");
    expectRefused(
      await verifyHandoff({ token, boardId: "board-a", secret: OTHER_SECRET }),
      "bad-signature"
    );
  });

  it("uses a fresh nonce, so the single-use ledger is meaningful", async () => {
    const first = decodeClaims((await mintHandoff()).split(".")[1]!);
    const second = decodeClaims((await mintHandoff()).split(".")[1]!);
    expect(first?.nonce).not.toBe(second?.nonce);
  });

  it("fails as a configuration fault when there is no secret", async () => {
    const exit = await Effect.runPromiseExit(
      mintHandoffToken({ boardId: BOARD, deviceEpoch: EPOCH, secret: "", now: NOW })
    );
    expect(Exit.isFailure(exit)).toBe(true);
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

describe("device cookie", () => {
  it("names one cookie per board", () => {
    expect(deviceCookieName(BOARD)).toBe(`${DEVICE_COOKIE_PREFIX}${BOARD}`);
    expect(deviceCookieName("a b.c")).toBe(`${DEVICE_COOKIE_PREFIX}a_b_c`);
  });

  it("uses a different name from the controller grant for the same board", () => {
    // A laptop can be both the TV and the remote; neither cookie may clobber
    // the other.
    expect(deviceCookieName(BOARD)).not.toBe(grantCookieName(BOARD));
  });

  it("serializes an httpOnly, lax, path-wide cookie and marks it secure on https", () => {
    const insecure = serializeDeviceCookie({
      boardId: BOARD,
      token: "tok",
      maxAgeSeconds: 3600,
      secure: false,
    });
    expect(insecure).toContain(`${DEVICE_COOKIE_PREFIX}${BOARD}=tok`);
    expect(insecure).toContain("HttpOnly");
    expect(insecure).toContain("SameSite=Lax");
    expect(insecure).toContain("Path=/");
    expect(insecure).toContain("Max-Age=3600");
    expect(insecure).not.toContain("Secure");

    const secure = serializeDeviceCookie({
      boardId: BOARD,
      token: "tok",
      maxAgeSeconds: 3600,
      secure: true,
    });
    expect(secure).toContain("Secure");
  });

  it("clamps a negative or fractional max-age", () => {
    expect(
      serializeDeviceCookie({
        boardId: BOARD,
        token: "t",
        maxAgeSeconds: -5,
        secure: false,
      })
    ).toContain("Max-Age=0");
    expect(
      serializeDeviceCookie({
        boardId: BOARD,
        token: "t",
        maxAgeSeconds: 10.9,
        secure: false,
      })
    ).toContain("Max-Age=10");
  });

  it("clears with a zero lifetime on the same name and path", () => {
    const cleared = clearDeviceCookie(BOARD, true);
    expect(cleared).toContain(`${DEVICE_COOKIE_PREFIX}${BOARD}=`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("Secure");
  });

  it("reads only this board's device grant out of a cookie header", () => {
    const header = `theme=dark; ${DEVICE_COOKIE_PREFIX}${BOARD}=abc.def.ghi; ${DEVICE_COOKIE_PREFIX}other=zzz`;
    expect(readDeviceCookies(header, BOARD)).toEqual(["abc.def.ghi"]);
    expect(readDeviceCookies(header, "other")).toEqual(["zzz"]);
    expect(readDeviceCookies(header, "absent")).toEqual([]);
  });

  it("does not read a controller grant out of the device cookie name", () => {
    const header = `${GRANT_COOKIE_PREFIX}${BOARD}=phone; ${DEVICE_COOKIE_PREFIX}${BOARD}=tv`;
    expect(readDeviceCookies(header, BOARD)).toEqual(["tv"]);
    expect(readGrantCookies(header, BOARD)).toEqual(["phone"]);
  });

  it("returns every cookie with this board's name, in the order sent", () => {
    const header = `${DEVICE_COOKIE_PREFIX}${BOARD}=injected; theme=dark; ${DEVICE_COOKIE_PREFIX}${BOARD}=genuine`;
    expect(readDeviceCookies(header, BOARD)).toEqual(["injected", "genuine"]);
  });

  it("returns nothing for absent, empty and malformed cookie headers", () => {
    expect(readDeviceCookies(null, BOARD)).toEqual([]);
    expect(readDeviceCookies(undefined, BOARD)).toEqual([]);
    expect(readDeviceCookies("", BOARD)).toEqual([]);
    expect(readDeviceCookies("garbage", BOARD)).toEqual([]);
    expect(readDeviceCookies(`${DEVICE_COOKIE_PREFIX}${BOARD}=`, BOARD)).toEqual([]);
    expect(readDeviceCookies(`=${DEVICE_COOKIE_PREFIX}${BOARD}`, BOARD)).toEqual([]);
  });

  it("round-trips a real device grant through serialize → read → verify", async () => {
    const grant = await mintDevice();
    const setCookie = serializeDeviceCookie({
      boardId: BOARD,
      token: grant,
      maxAgeSeconds: DEFAULT_DEVICE_TTL_SECONDS,
      secure: true,
    });
    // Browsers send back only `name=value`, so that is what is parsed here.
    const sent = setCookie.split(";")[0]!;
    const read = readDeviceCookies(sent, BOARD)[0] ?? null;
    expect(read).toBe(grant);
    expect((await verifyDevice({ token: read! })).ok).toBe(true);
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

describe("device epoch — revocation", () => {
  const deviceAt = (epoch: number, boardId = BOARD) =>
    mintDevice({ boardId, deviceEpoch: epoch });

  const verifyAt = (token: string, epoch: number, boardId = BOARD) =>
    verifyDevice({ token, boardId, deviceEpoch: epoch });

  it("a device grant minted at epoch N still verifies at epoch N", async () => {
    expect((await verifyAt(await deviceAt(7), 7)).ok).toBe(true);
  });

  it("a device grant minted at epoch N fails at epoch N+1", async () => {
    expectRefused(await verifyAt(await deviceAt(7), 8), "bad-signature");
  });

  it("every earlier epoch stays dead, not just the previous one", async () => {
    const grant = await deviceAt(0);
    for (const epoch of [1, 2, 3, 50]) {
      expectRefused(await verifyAt(grant, epoch), "bad-signature");
    }
  });

  it("bumping board A does not affect a device grant for board B", async () => {
    const forB = await deviceAt(0, "board-b");
    expect((await verifyAt(forB, 0, "board-b")).ok).toBe(true);
    expectRefused(await verifyAt(forB, 1, "board-b"), "bad-signature");
  });

  it("covers the handoff token too, so un-pairing kills an approval in flight", async () => {
    const token = await mintHandoff({ deviceEpoch: 4 });
    expect((await verifyHandoff({ token, deviceEpoch: 4 })).ok).toBe(true);
    expectRefused(await verifyHandoff({ token, deviceEpoch: 5 }), "bad-signature");
  });

  it("does not let a device epoch stand in for a board id, or vice versa", async () => {
    const grant = await deviceAt(1, "ab");
    expectRefused(await verifyAt(grant, 1, "a"), "bad-signature");
    expectRefused(await verifyAt(grant, 11, "ab"), "bad-signature");
  });
});

describe("verifyDeviceGrants — many cookies, one name", () => {
  const verifyMany = (tokens: ReadonlyArray<string>, deviceEpoch = EPOCH) =>
    run(
      verifyDeviceGrants({
        tokens,
        boardId: BOARD,
        deviceEpoch,
        secret: SECRET,
        now: NOW,
      })
    );

  it("accepts when the *second* cookie is the valid one", async () => {
    // A TV accumulating a neighbour-injected `fb_device_<id>` is exactly as
    // plausible as a phone accumulating an injected `fb_grant_<id>`.
    const genuine = await mintDevice();
    const verdict = await verifyMany(["junk", genuine]);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.issuedAt).toBe(NOW);
  });

  it("accepts when the valid one is first, or the only one", async () => {
    const genuine = await mintDevice();
    expect((await verifyMany([genuine, "junk"])).ok).toBe(true);
    expect((await verifyMany([genuine])).ok).toBe(true);
  });

  it("refuses when none verify, reporting the most specific reason", async () => {
    const stale = await mintDevice({ ttlSeconds: 60 });
    const later = run(
      verifyDeviceGrants({
        tokens: ["junk", stale],
        boardId: BOARD,
        deviceEpoch: EPOCH,
        secret: SECRET,
        now: NOW + 60_001,
      })
    );
    expectRefused(await later, "expired");
  });

  it("refuses an empty list as malformed", async () => {
    expectRefused(await verifyMany([]), "malformed");
  });

  it("does not let a revoked device grant sneak in beside a fresh one", async () => {
    const revoked = await mintDevice({ deviceEpoch: 0 });
    expectRefused(await verifyMany([revoked, revoked], 1), "bad-signature");
  });

  it("does not accept a controller grant presented in the device cookie", async () => {
    // Same board, same epoch, same key — only the prefix differs, and that is
    // the whole fence.
    const controller = await run(
      mintControllerGrant({ boardId: BOARD, grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    expectRefused(await verifyMany([controller]), "malformed");
  });
});

describe("cross-family separation — four prefixes, one key", () => {
  /** Same board, same epoch, same nonce, same clock, same TTL. */
  const FIXED_NONCE = "fixed-nonce-for-domain-separation";
  const CROSS_EPOCH = 3;
  const CROSS_TTL = 60;

  const four = () =>
    Promise.all([
      run(
        mintPairingToken({
          boardId: BOARD,
          grantEpoch: CROSS_EPOCH,
          secret: SECRET,
          now: NOW,
          ttlSeconds: CROSS_TTL,
          nonce: FIXED_NONCE,
        })
      ),
      run(
        mintControllerGrant({
          boardId: BOARD,
          grantEpoch: CROSS_EPOCH,
          secret: SECRET,
          now: NOW,
          ttlSeconds: CROSS_TTL,
          nonce: FIXED_NONCE,
        })
      ),
      mintDevice({
        deviceEpoch: CROSS_EPOCH,
        ttlSeconds: CROSS_TTL,
        nonce: FIXED_NONCE,
      }),
      mintHandoff({
        deviceEpoch: CROSS_EPOCH,
        ttlSeconds: CROSS_TTL,
        nonce: FIXED_NONCE,
      }),
    ]);

  it("mints four different tokens from identical claims", async () => {
    const tokens = await four();
    expect(new Set(tokens).size).toBe(4);

    // The payload is byte-identical across all four — every difference comes
    // from the prefix being inside the signed message, which is the only thing
    // keeping the families apart.
    const payloads = tokens.map((token) => token.split(".")[1]!);
    expect(new Set(payloads).size).toBe(1);
    const signatures = tokens.map((token) => token.split(".")[2]!);
    expect(new Set(signatures).size).toBe(4);
    expect(tokens.map((token) => token.split(".")[0])).toEqual([
      PAIRING_PREFIX,
      GRANT_PREFIX,
      DEVICE_PREFIX,
      HANDOFF_PREFIX,
    ]);
  });

  it("refuses a controller grant as a device grant, and a device grant as a controller grant", async () => {
    // A phone's 30-day grant must never be spendable as a TV's 180-day one.
    const controller = await run(
      mintControllerGrant({ boardId: BOARD, grantEpoch: EPOCH, secret: SECRET, now: NOW })
    );
    const device = await mintDevice();

    expectRefused(await verifyDevice({ token: controller }), "malformed");
    expectRefused(
      await run(
        verifyControllerGrant({
          token: device,
          boardId: BOARD,
          grantEpoch: EPOCH,
          secret: SECRET,
          now: NOW,
        })
      ),
      "malformed"
    );
  });

  it("refuses a pairing token as a handoff, and a handoff as a pairing token", async () => {
    // The escalation this fence exists for: a QR photographed off the TV walked
    // into `/tv/claim` and cashed for the longer-lived device credential.
    const pairing = await mint();
    const handoff = await mintHandoff();

    expectRefused(await verifyHandoff({ token: pairing }), "malformed");
    expectRefused(await verify({ token: handoff }), "malformed");
  });

  it("refuses a handoff as either kind of grant", async () => {
    const handoff = await mintHandoff();
    expectRefused(await verifyDevice({ token: handoff }), "malformed");
    expectRefused(
      await run(
        verifyControllerGrant({
          token: handoff,
          boardId: BOARD,
          grantEpoch: EPOCH,
          secret: SECRET,
          now: NOW,
        })
      ),
      "malformed"
    );
  });

  it("refuses every cross-family presentation as malformed, never bad-signature", async () => {
    // The distinction matters: `malformed` proves the prefix check ran *before*
    // the key was consulted, so a wrong-purpose token never reaches WebCrypto.
    const [pairing, controller, device, handoff] = await four();
    const verifiers = [
      (token: string) => verify({ token, grantEpoch: CROSS_EPOCH }),
      (token: string) =>
        run(
          verifyControllerGrant({
            token,
            boardId: BOARD,
            grantEpoch: CROSS_EPOCH,
            secret: SECRET,
            now: NOW,
          })
        ),
      (token: string) => verifyDevice({ token, deviceEpoch: CROSS_EPOCH }),
      (token: string) => verifyHandoff({ token, deviceEpoch: CROSS_EPOCH }),
    ];
    const tokens = [pairing, controller, device, handoff];

    for (let family = 0; family < tokens.length; family += 1) {
      for (let verifier = 0; verifier < verifiers.length; verifier += 1) {
        const verdict = await verifiers[verifier]!(tokens[family]!);
        if (family === verifier) {
          expect(verdict.ok).toBe(true);
        } else {
          expectRefused(verdict, "malformed");
        }
      }
    }
  });
});

describe("two epochs — grantEpoch and deviceEpoch are independent", () => {
  const controllerAt = (grantEpoch: number) =>
    run(mintControllerGrant({ boardId: BOARD, grantEpoch, secret: SECRET, now: NOW }));

  const verifyControllerAt = (token: string, grantEpoch: number) =>
    run(
      verifyControllerGrant({
        token,
        boardId: BOARD,
        grantEpoch,
        secret: SECRET,
        now: NOW,
      })
    );

  it("a device grant survives the board's grantEpoch moving", async () => {
    // "Kick every phone off my board" must not un-pair the TV.
    const device = await mintDevice({ deviceEpoch: 2 });
    const controller = await controllerAt(5);

    expectRefused(await verifyControllerAt(controller, 6), "bad-signature");
    expect((await verifyDevice({ token: device, deviceEpoch: 2 })).ok).toBe(true);
  });

  it("a controller grant survives the board's deviceEpoch moving", async () => {
    // ...and "un-pair the TV" must not kick every phone off.
    const device = await mintDevice({ deviceEpoch: 2 });
    const controller = await controllerAt(5);

    expectRefused(await verifyDevice({ token: device, deviceEpoch: 3 }), "bad-signature");
    expect((await verifyControllerAt(controller, 5)).ok).toBe(true);
  });

  it("bumping deviceEpoch kills the device grant and the handoff, not the controller grant", async () => {
    const device = await mintDevice({ deviceEpoch: 2 });
    const handoff = await mintHandoff({ deviceEpoch: 2 });
    const controller = await controllerAt(5);

    expectRefused(await verifyDevice({ token: device, deviceEpoch: 3 }), "bad-signature");
    expectRefused(
      await verifyHandoff({ token: handoff, deviceEpoch: 3 }),
      "bad-signature"
    );
    expect((await verifyControllerAt(controller, 5)).ok).toBe(true);
  });

  it("bumping grantEpoch kills the controller grant and the QR, not the device grant", async () => {
    const device = await mintDevice({ deviceEpoch: 2 });
    const handoff = await mintHandoff({ deviceEpoch: 2 });
    const controller = await controllerAt(5);
    const pairing = await mint({ grantEpoch: 5 });

    expectRefused(await verifyControllerAt(controller, 6), "bad-signature");
    expectRefused(await verify({ token: pairing, grantEpoch: 6 }), "bad-signature");
    expect((await verifyDevice({ token: device, deviceEpoch: 2 })).ok).toBe(true);
    expect((await verifyHandoff({ token: handoff, deviceEpoch: 2 })).ok).toBe(true);
  });

  it("the two counters can hold the same value without the families colliding", async () => {
    // Both epochs at 4: the tokens still differ, so a device grant is not a
    // controller grant that happened to be signed at a matching counter.
    const device = await mintDevice({ deviceEpoch: 4 });
    const controller = await controllerAt(4);
    expect(device).not.toBe(controller);
    expectRefused(await verifyDevice({ token: controller, deviceEpoch: 4 }), "malformed");
    expectRefused(await verifyControllerAt(device, 4), "malformed");
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
