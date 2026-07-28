import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUOTA,
  MAX_QUOTA_LIMIT,
  MAX_QUOTA_WINDOW_SECONDS,
  MAX_SPENDER_LENGTH,
  QUOTA_ENDPOINTS,
  QUOTA_KEY_PREFIX,
  boardQuotaKey,
  decideQuota,
  isQuotaEntry,
  parseQuotaSpend,
  parseSpendQuotaRequest,
  quotaSpendResult,
  readCount,
  retryAfterSeconds,
  spenderId,
  spenderQuotaKey,
  windowStart,
} from "../quota";

/** An exact hour boundary, so window arithmetic is readable in the assertions. */
const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;
const WINDOW = 3600;

describe("spenderId", () => {
  it("keys an owner by account, not by any presented grant", () => {
    expect(
      spenderId({ via: "owner", ownerId: "user-1", grantNonce: "nonce-1" })
    ).toBe("owner:user-1");
  });

  it("keys a paired phone by the nonce inside its grant", () => {
    expect(
      spenderId({ via: "grant", ownerId: "user-1", grantNonce: "nonce-1" })
    ).toBe("grant:nonce-1");
  });

  it("gives two guests on one board separate allowances", () => {
    const a = spenderId({ via: "grant", ownerId: "u", grantNonce: "aaa" });
    const b = spenderId({ via: "grant", ownerId: "u", grantNonce: "bbb" });
    expect(a).not.toBe(b);
  });

  it("never collides an owner id with a grant nonce of the same text", () => {
    const owner = spenderId({ via: "owner", ownerId: "x", grantNonce: null });
    const guest = spenderId({ via: "grant", ownerId: "y", grantNonce: "x" });
    expect(owner).not.toBe(guest);
  });

  it("falls back to the owner bucket when a grant carries no nonce", () => {
    // Not reachable from a verified grant (the nonce is covered by the MAC), but
    // the function is total and must not produce a "grant:null" bucket.
    expect(
      spenderId({ via: "grant", ownerId: "user-1", grantNonce: null })
    ).toBe("owner:user-1");
  });
});

describe("windowStart", () => {
  it("floors to the window boundary", () => {
    expect(windowStart(NOW, WINDOW)).toBe(Math.floor(NOW / HOUR) * HOUR);
  });

  it("is stable for every instant inside one window", () => {
    const start = windowStart(NOW, WINDOW);
    expect(windowStart(start, WINDOW)).toBe(start);
    expect(windowStart(start + 1, WINDOW)).toBe(start);
    expect(windowStart(start + HOUR - 1, WINDOW)).toBe(start);
  });

  it("advances by exactly one window at the boundary", () => {
    const start = windowStart(NOW, WINDOW);
    expect(windowStart(start + HOUR, WINDOW)).toBe(start + HOUR);
  });
});

describe("retryAfterSeconds", () => {
  it("reports the whole window at the very start of one", () => {
    const start = windowStart(NOW, WINDOW);
    expect(retryAfterSeconds(start, WINDOW)).toBe(WINDOW);
  });

  it("rounds up, so the advice is never optimistic", () => {
    const start = windowStart(NOW, WINDOW);
    // 1.5s left → told to wait 2, not 1.
    expect(retryAfterSeconds(start + HOUR - 1500, WINDOW)).toBe(2);
  });

  it("never tells a caller to retry in zero seconds", () => {
    const start = windowStart(NOW, WINDOW);
    expect(retryAfterSeconds(start + HOUR - 1, WINDOW)).toBe(1);
  });
});

describe("storage keys", () => {
  it("prefixes every key so pruning can scan just the counters", () => {
    expect(spenderQuotaKey("generate", "grant:a", 0)).toContain(
      QUOTA_KEY_PREFIX
    );
    expect(boardQuotaKey("generate", 0)).toContain(QUOTA_KEY_PREFIX);
  });

  it("separates the two endpoints, so one cap cannot eat the other", () => {
    expect(spenderQuotaKey("generate", "s", 0)).not.toBe(
      spenderQuotaKey("transcribe", "s", 0)
    );
    expect(boardQuotaKey("generate", 0)).not.toBe(
      boardQuotaKey("transcribe", 0)
    );
  });

  it("separates the spender bucket from the board bucket", () => {
    expect(spenderQuotaKey("generate", "s", 0)).not.toBe(
      boardQuotaKey("generate", 0)
    );
  });

  it("makes a new window a new key, so nothing has to be reset", () => {
    expect(spenderQuotaKey("generate", "s", 0)).not.toBe(
      spenderQuotaKey("generate", "s", HOUR)
    );
  });
});

describe("isQuotaEntry / readCount", () => {
  it("accepts a well-formed entry", () => {
    expect(isQuotaEntry({ count: 3, expiresAt: NOW })).toBe(true);
    expect(readCount({ count: 3, expiresAt: NOW })).toBe(3);
  });

  it("treats an absent slot as zero", () => {
    expect(readCount(undefined)).toBe(0);
    expect(readCount(null)).toBe(0);
  });

  it("fails open on a corrupt slot rather than bricking the board", () => {
    for (const bad of [
      42,
      "3",
      {},
      { count: "3", expiresAt: NOW },
      { count: 3 },
      { count: Number.NaN, expiresAt: NOW },
      { count: 3, expiresAt: Number.POSITIVE_INFINITY },
    ]) {
      expect(isQuotaEntry(bad)).toBe(false);
      expect(readCount(bad)).toBe(0);
    }
  });
});

describe("decideQuota", () => {
  const base = {
    spenderLimit: 3,
    boardLimit: 5,
    now: NOW,
    windowSeconds: WINDOW,
  };

  it("allows and increments both counters while under both limits", () => {
    const d = decideQuota({ ...base, spenderCount: 0, boardCount: 0 });
    expect(d.allowed).toBe(true);
    expect(d.spenderCount).toBe(1);
    expect(d.boardCount).toBe(1);
    expect(d.retryAfter).toBe(0);
  });

  it("allows the call that lands exactly on the limit", () => {
    const d = decideQuota({ ...base, spenderCount: 2, boardCount: 0 });
    expect(d.allowed).toBe(true);
    expect(d.spenderCount).toBe(3);
  });

  it("refuses the call after the spender limit is reached", () => {
    const d = decideQuota({ ...base, spenderCount: 3, boardCount: 0 });
    expect(d.allowed).toBe(false);
    expect(d.retryAfter).toBeGreaterThan(0);
  });

  it("refuses on the board ceiling even when the spender is fresh", () => {
    // This is the re-pairing bypass: a brand-new nonce has spent nothing, but
    // the board as a whole is already out of budget.
    const d = decideQuota({ ...base, spenderCount: 0, boardCount: 5 });
    expect(d.allowed).toBe(false);
  });

  it("increments nothing when it refuses", () => {
    const d = decideQuota({ ...base, spenderCount: 3, boardCount: 4 });
    expect(d.allowed).toBe(false);
    expect(d.spenderCount).toBe(3);
    expect(d.boardCount).toBe(4);
  });

  it("hands back the seconds to the window edge when refusing", () => {
    const start = windowStart(NOW, WINDOW);
    const d = decideQuota({
      ...base,
      now: start + HOUR - 5000,
      spenderCount: 3,
      boardCount: 0,
    });
    expect(d.retryAfter).toBe(5);
  });
});

describe("parseSpendQuotaRequest", () => {
  const valid = {
    endpoint: "generate",
    spender: "grant:abc",
    spenderLimit: 20,
    boardLimit: 60,
    windowSeconds: 3600,
  };

  it("round-trips a well-formed request", () => {
    expect(parseSpendQuotaRequest(JSON.stringify(valid))).toEqual(valid);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseSpendQuotaRequest("{not json")).toBeNull();
    expect(parseSpendQuotaRequest("")).toBeNull();
  });

  it("rejects an unknown endpoint", () => {
    expect(
      parseSpendQuotaRequest(JSON.stringify({ ...valid, endpoint: "deploy" }))
    ).toBeNull();
  });

  it("refuses a spender id long enough to bloat storage", () => {
    const spender = "g".repeat(MAX_SPENDER_LENGTH + 1);
    expect(
      parseSpendQuotaRequest(JSON.stringify({ ...valid, spender }))
    ).toBeNull();
  });

  it("refuses an empty spender", () => {
    expect(
      parseSpendQuotaRequest(JSON.stringify({ ...valid, spender: "" }))
    ).toBeNull();
  });

  it("refuses a caller asking for an effectively unlimited cap", () => {
    for (const field of ["spenderLimit", "boardLimit"] as const) {
      expect(
        parseSpendQuotaRequest(
          JSON.stringify({ ...valid, [field]: MAX_QUOTA_LIMIT + 1 })
        )
      ).toBeNull();
      expect(
        parseSpendQuotaRequest(JSON.stringify({ ...valid, [field]: 0 }))
      ).toBeNull();
    }
  });

  it("refuses a window beyond the ceiling", () => {
    expect(
      parseSpendQuotaRequest(
        JSON.stringify({ ...valid, windowSeconds: MAX_QUOTA_WINDOW_SECONDS + 1 })
      )
    ).toBeNull();
  });

  it("refuses non-integer limits", () => {
    expect(
      parseSpendQuotaRequest(JSON.stringify({ ...valid, spenderLimit: 1.5 }))
    ).toBeNull();
  });
});

describe("parseQuotaSpend", () => {
  it("round-trips the room's answer", () => {
    expect(parseQuotaSpend(quotaSpendResult(true, 0))).toEqual({
      type: "quota",
      allowed: true,
      retryAfter: 0,
    });
  });

  it("returns null on anything unreadable, so the caller can fail closed", () => {
    expect(parseQuotaSpend(undefined)).toBeNull();
    expect(parseQuotaSpend({ type: "nonce", spent: true })).toBeNull();
    expect(parseQuotaSpend({ allowed: true, retryAfter: 0 })).toBeNull();
  });
});

describe("DEFAULT_QUOTA", () => {
  it("covers every metered endpoint", () => {
    for (const endpoint of QUOTA_ENDPOINTS) {
      expect(DEFAULT_QUOTA[endpoint]).toBeDefined();
    }
  });

  it("keeps the board ceiling above any single spender's allowance", () => {
    // Otherwise the per-spender bucket would be dead code — the board cap would
    // always bite first, and one guest could lock out the whole household.
    for (const endpoint of QUOTA_ENDPOINTS) {
      const policy = DEFAULT_QUOTA[endpoint];
      expect(policy.boardLimit).toBeGreaterThan(policy.spenderLimit);
    }
  });

  it("stays inside the bounds the wire schema will accept", () => {
    for (const endpoint of QUOTA_ENDPOINTS) {
      const policy = DEFAULT_QUOTA[endpoint];
      expect(
        parseSpendQuotaRequest(
          JSON.stringify({
            endpoint,
            spender: "grant:abc",
            spenderLimit: policy.spenderLimit,
            boardLimit: policy.boardLimit,
            windowSeconds: policy.windowSeconds,
          })
        )
      ).not.toBeNull();
    }
  });
});
