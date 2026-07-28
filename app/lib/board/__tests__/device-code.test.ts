import { describe, expect, it } from "vitest";

import { MAX_TOKEN_LENGTH } from "../pairing";
import {
  DEVICE_CODE_ALPHABET,
  DEVICE_CODE_KEY,
  DEVICE_CODE_LENGTH,
  DEVICE_CODE_TTL_SECONDS,
  MAX_BOARD_ID_LENGTH,
  MAX_DEVICE_CODE_ATTEMPTS,
  WATCHER_BYTES,
  decodeDeviceCodeRecord,
  deviceCodeApproveResult,
  deviceCodeIssueResult,
  deviceCodeRoomName,
  generateDeviceCode,
  generateWatcher,
  isDeviceCodeLive,
  normalizeDeviceCode,
  parseApproveDeviceCodeRequest,
  parseDeviceCodeApprove,
  parseDeviceCodeIssue,
  parseIssueDeviceCodeRequest,
} from "../device-code";

const NOW = 1_700_000_000_000;

/** A record shaped exactly as the room persists one. */
const record = {
  code: "K7Q2XM",
  watcher: "w".repeat(22),
  issuedAt: NOW,
  expiresAt: NOW + DEVICE_CODE_TTL_SECONDS * 1000,
};

describe("DEVICE_CODE_ALPHABET", () => {
  it("holds exactly 32 characters, so modulo over a byte is unbiased", () => {
    // 32 divides 256, which is the whole reason the generator can take a raw
    // random byte modulo the alphabet length with no rejection sampling.
    expect(DEVICE_CODE_ALPHABET).toHaveLength(32);
    expect(256 % DEVICE_CODE_ALPHABET.length).toBe(0);
  });

  it("has no duplicate characters", () => {
    expect(new Set(DEVICE_CODE_ALPHABET).size).toBe(
      DEVICE_CODE_ALPHABET.length
    );
  });

  it("excludes every glyph confusable across a living room", () => {
    for (const ambiguous of ["0", "O", "1", "I"]) {
      expect(DEVICE_CODE_ALPHABET).not.toContain(ambiguous);
    }
  });

  it("is uppercase only, so normalization can upper-case unconditionally", () => {
    expect(DEVICE_CODE_ALPHABET).toBe(DEVICE_CODE_ALPHABET.toUpperCase());
  });
});

describe("constants", () => {
  it("keeps the short code safe with a short TTL and an attempt cap", () => {
    // 32^6 is only ~30 bits; the other two numbers are what make that defensible.
    expect(DEVICE_CODE_LENGTH).toBe(6);
    expect(DEVICE_CODE_TTL_SECONDS).toBe(300);
    expect(MAX_DEVICE_CODE_ATTEMPTS).toBe(5);
  });

  it("names one storage key for a room that is about one thing", () => {
    expect(DEVICE_CODE_KEY).toBe("device-code");
  });
});

describe("generateDeviceCode", () => {
  it("produces a code of exactly the advertised length", () => {
    for (let i = 0; i < 50; i += 1) {
      expect(generateDeviceCode()).toHaveLength(DEVICE_CODE_LENGTH);
    }
  });

  it("only ever draws from the alphabet", () => {
    for (let i = 0; i < 200; i += 1) {
      for (const character of generateDeviceCode()) {
        expect(DEVICE_CODE_ALPHABET).toContain(character);
      }
    }
  });

  it("round-trips through its own normalizer", () => {
    for (let i = 0; i < 50; i += 1) {
      const code = generateDeviceCode();
      expect(normalizeDeviceCode(code)).toBe(code);
    }
  });

  it("does not repeat itself across calls", () => {
    // 32^6 codes: 100 draws colliding would mean the randomness is broken, not
    // that we got unlucky.
    const codes = new Set(
      Array.from({ length: 100 }, () => generateDeviceCode())
    );
    expect(codes.size).toBe(100);
  });
});

describe("generateWatcher", () => {
  it("emits 128 bits of padding-free base64url", () => {
    const watcher = generateWatcher();
    expect(watcher).toMatch(/^[A-Za-z0-9_-]+$/);
    // 16 bytes → 22 base64 chars once the `=` padding is stripped.
    expect(watcher).toHaveLength(Math.ceil((WATCHER_BYTES * 8) / 6));
  });

  it("is different every time — it is the secret binding a socket to a code", () => {
    const watchers = new Set(Array.from({ length: 100 }, generateWatcher));
    expect(watchers.size).toBe(100);
  });
});

describe("normalizeDeviceCode", () => {
  it("accepts a canonical code unchanged", () => {
    expect(normalizeDeviceCode("K7Q2XM")).toBe("K7Q2XM");
  });

  it("accepts lowercase, because a phone keyboard defaults to it", () => {
    expect(normalizeDeviceCode("k7q2xm")).toBe("K7Q2XM");
    expect(normalizeDeviceCode("k7Q2xM")).toBe("K7Q2XM");
  });

  it("accepts the grouping a TV may print for legibility", () => {
    expect(normalizeDeviceCode("k7q2 xm")).toBe("K7Q2XM");
    expect(normalizeDeviceCode("K7Q2-XM")).toBe("K7Q2XM");
    expect(normalizeDeviceCode(" K7Q2 - XM ")).toBe("K7Q2XM");
    expect(normalizeDeviceCode("\tK7Q2\nXM\r")).toBe("K7Q2XM");
  });

  it("rejects anything that is not exactly six characters", () => {
    expect(normalizeDeviceCode("K7Q2X")).toBeNull();
    expect(normalizeDeviceCode("K7Q2XMM")).toBeNull();
    expect(normalizeDeviceCode("")).toBeNull();
    expect(normalizeDeviceCode("      ")).toBeNull();
  });

  it("rejects a character outside the alphabet instead of folding it", () => {
    // The point: `0` is not in the alphabet, and this must NOT quietly become
    // `O` (or vice versa). A lossy fold would turn a typo into a *different
    // valid code* addressing somebody else's pairing room.
    expect(normalizeDeviceCode("K7Q2X0")).toBeNull();
    expect(normalizeDeviceCode("K7Q2XO")).toBeNull();
    expect(normalizeDeviceCode("K7Q2X1")).toBeNull();
    expect(normalizeDeviceCode("K7Q2XI")).toBeNull();
    expect(normalizeDeviceCode("K7Q2X!")).toBeNull();
  });

  it("rejects a non-string without throwing", () => {
    for (const bad of [undefined, null, 123456, {}, [], true, Symbol("K7Q2XM")]) {
      expect(normalizeDeviceCode(bad)).toBeNull();
    }
  });
});

describe("deviceCodeRoomName", () => {
  it("derives the room address straight from the code", () => {
    expect(deviceCodeRoomName("K7Q2XM")).toBe("code:K7Q2XM");
  });

  it("keeps code rooms out of the board-id namespace", () => {
    expect(deviceCodeRoomName("board-1")).not.toBe("board-1");
  });

  it("gives two codes two rooms", () => {
    expect(deviceCodeRoomName("K7Q2XM")).not.toBe(deviceCodeRoomName("K7Q2XN"));
  });
});

describe("decodeDeviceCodeRecord", () => {
  it("round-trips a well-formed record", () => {
    expect(decodeDeviceCodeRecord(record)).toEqual(record);
  });

  it("rejects a partial record — persisted state is untrusted on read", () => {
    const { watcher: _watcher, ...missingWatcher } = record;
    const { expiresAt: _expiresAt, ...missingExpiry } = record;
    expect(decodeDeviceCodeRecord(missingWatcher)).toBeNull();
    expect(decodeDeviceCodeRecord(missingExpiry)).toBeNull();
    expect(decodeDeviceCodeRecord({})).toBeNull();
  });

  it("rejects wrong types and non-integer timestamps", () => {
    expect(decodeDeviceCodeRecord({ ...record, code: 123 })).toBeNull();
    expect(decodeDeviceCodeRecord({ ...record, watcher: null })).toBeNull();
    expect(
      decodeDeviceCodeRecord({ ...record, issuedAt: "yesterday" })
    ).toBeNull();
    expect(decodeDeviceCodeRecord({ ...record, expiresAt: 1.5 })).toBeNull();
  });

  it("rejects a non-object slot", () => {
    for (const bad of [undefined, null, 42, "record", []]) {
      expect(decodeDeviceCodeRecord(bad)).toBeNull();
    }
  });
});

describe("parseIssueDeviceCodeRequest", () => {
  const valid = {
    code: "K7Q2XM",
    watcher: "w".repeat(22),
    ttlSeconds: DEVICE_CODE_TTL_SECONDS,
  };

  it("round-trips a well-formed request", () => {
    expect(parseIssueDeviceCodeRequest(JSON.stringify(valid))).toEqual(valid);
  });

  it("accepts an ArrayBuffer body as well as a string", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(valid));
    expect(
      parseIssueDeviceCodeRequest(bytes.buffer as ArrayBuffer)
    ).toEqual(valid);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseIssueDeviceCodeRequest("{not json")).toBeNull();
    expect(parseIssueDeviceCodeRequest("")).toBeNull();
    expect(parseIssueDeviceCodeRequest("null")).toBeNull();
  });

  it("rejects wrong types", () => {
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, code: 726212 }))
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, watcher: 42 }))
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, ttlSeconds: "60" }))
    ).toBeNull();
  });

  it("rejects a missing field", () => {
    for (const field of ["code", "watcher", "ttlSeconds"]) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      expect(parseIssueDeviceCodeRequest(JSON.stringify(body))).toBeNull();
    }
  });

  it("rejects a ttl outside the room's own ceiling", () => {
    // A call site may shorten a code's life, never extend it.
    expect(
      parseIssueDeviceCodeRequest(
        JSON.stringify({ ...valid, ttlSeconds: DEVICE_CODE_TTL_SECONDS + 1 })
      )
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, ttlSeconds: 0 }))
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, ttlSeconds: -30 }))
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, ttlSeconds: 1.5 }))
    ).toBeNull();
  });

  it("accepts the boundary values of the ttl range", () => {
    for (const ttlSeconds of [1, DEVICE_CODE_TTL_SECONDS]) {
      expect(
        parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, ttlSeconds }))
      ).toEqual({ ...valid, ttlSeconds });
    }
  });

  it("rejects a code that skipped normalization", () => {
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, code: "K7Q2X" }))
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, code: "K7Q2XMM" }))
    ).toBeNull();
  });

  it("refuses a watcher long enough to bloat storage", () => {
    expect(
      parseIssueDeviceCodeRequest(
        JSON.stringify({ ...valid, watcher: "w".repeat(MAX_TOKEN_LENGTH + 1) })
      )
    ).toBeNull();
    expect(
      parseIssueDeviceCodeRequest(JSON.stringify({ ...valid, watcher: "" }))
    ).toBeNull();
  });
});

describe("parseApproveDeviceCodeRequest", () => {
  const valid = {
    code: "K7Q2XM",
    boardId: "board-1",
    handoff: "fbh1.payload.signature",
  };

  it("round-trips a well-formed request", () => {
    expect(parseApproveDeviceCodeRequest(JSON.stringify(valid))).toEqual(valid);
  });

  it("accepts an ArrayBuffer body as well as a string", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(valid));
    expect(
      parseApproveDeviceCodeRequest(bytes.buffer as ArrayBuffer)
    ).toEqual(valid);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseApproveDeviceCodeRequest("{not json")).toBeNull();
    expect(parseApproveDeviceCodeRequest("")).toBeNull();
  });

  it("rejects wrong types", () => {
    expect(
      parseApproveDeviceCodeRequest(JSON.stringify({ ...valid, boardId: 7 }))
    ).toBeNull();
    expect(
      parseApproveDeviceCodeRequest(JSON.stringify({ ...valid, handoff: null }))
    ).toBeNull();
  });

  it("rejects an empty string in any field", () => {
    for (const field of ["boardId", "handoff"]) {
      expect(
        parseApproveDeviceCodeRequest(JSON.stringify({ ...valid, [field]: "" }))
      ).toBeNull();
    }
  });

  it("rejects a missing field", () => {
    for (const field of ["code", "boardId", "handoff"]) {
      const body: Record<string, unknown> = { ...valid };
      delete body[field];
      expect(parseApproveDeviceCodeRequest(JSON.stringify(body))).toBeNull();
    }
  });

  it("refuses a handoff longer than any token we would ever mint", () => {
    expect(
      parseApproveDeviceCodeRequest(
        JSON.stringify({ ...valid, handoff: "h".repeat(MAX_TOKEN_LENGTH + 1) })
      )
    ).toBeNull();
    expect(
      parseApproveDeviceCodeRequest(
        JSON.stringify({ ...valid, handoff: "h".repeat(MAX_TOKEN_LENGTH) })
      )
    ).not.toBeNull();
  });

  it("bounds the board id too", () => {
    expect(
      parseApproveDeviceCodeRequest(
        JSON.stringify({ ...valid, boardId: "b".repeat(MAX_BOARD_ID_LENGTH + 1) })
      )
    ).toBeNull();
  });
});

describe("deviceCodeIssueResult / parseDeviceCodeIssue", () => {
  it("round-trips both answers", () => {
    expect(deviceCodeIssueResult(true)).toEqual({
      type: "device-code-issue",
      issued: true,
    });
    expect(parseDeviceCodeIssue(deviceCodeIssueResult(true))).toBe(true);
    expect(parseDeviceCodeIssue(deviceCodeIssueResult(false))).toBe(false);
  });

  it("returns null on an unrecognised payload rather than reading a refusal", () => {
    // A shape mismatch must raise a typed error at the call site, not be
    // silently mistaken for "the room declined".
    expect(parseDeviceCodeIssue(undefined)).toBeNull();
    expect(parseDeviceCodeIssue(null)).toBeNull();
    expect(parseDeviceCodeIssue([])).toBeNull();
    expect(parseDeviceCodeIssue("issued")).toBeNull();
    expect(parseDeviceCodeIssue({ issued: true })).toBeNull();
    expect(parseDeviceCodeIssue({ type: "nonce", spent: true })).toBeNull();
    expect(parseDeviceCodeIssue({ type: "device-code-issue" })).toBeNull();
    expect(
      parseDeviceCodeIssue({ type: "device-code-issue", issued: "yes" })
    ).toBeNull();
  });
});

describe("deviceCodeApproveResult / parseDeviceCodeApprove", () => {
  const outcomes = [
    "approved",
    "unknown",
    "expired",
    "already-approved",
  ] as const;

  it("round-trips every outcome", () => {
    for (const outcome of outcomes) {
      expect(deviceCodeApproveResult(outcome)).toEqual({
        type: "device-code-approve",
        outcome,
      });
      expect(parseDeviceCodeApprove(deviceCodeApproveResult(outcome))).toBe(
        outcome
      );
    }
  });

  it("returns null on an unrecognised payload rather than guessing", () => {
    // Reading a shape mismatch as "unknown" would tell the owner they mistyped
    // a code they typed perfectly.
    expect(parseDeviceCodeApprove(undefined)).toBeNull();
    expect(parseDeviceCodeApprove(null)).toBeNull();
    expect(parseDeviceCodeApprove([])).toBeNull();
    expect(parseDeviceCodeApprove({ outcome: "approved" })).toBeNull();
    expect(
      parseDeviceCodeApprove({ type: "device-code-issue", issued: true })
    ).toBeNull();
    expect(parseDeviceCodeApprove({ type: "device-code-approve" })).toBeNull();
    expect(
      parseDeviceCodeApprove({ type: "device-code-approve", outcome: "revoked" })
    ).toBeNull();
    expect(
      parseDeviceCodeApprove({ type: "device-code-approve", outcome: 1 })
    ).toBeNull();
  });

  it("does not confuse the two result shapes for each other", () => {
    expect(parseDeviceCodeIssue(deviceCodeApproveResult("approved"))).toBeNull();
    expect(parseDeviceCodeApprove(deviceCodeIssueResult(true))).toBeNull();
  });
});

describe("isDeviceCodeLive", () => {
  it("is live for every instant before the expiry", () => {
    expect(isDeviceCodeLive(record, record.issuedAt)).toBe(true);
    expect(isDeviceCodeLive(record, record.expiresAt - 1)).toBe(true);
  });

  it("is dead exactly at the expiry, not one millisecond after", () => {
    expect(isDeviceCodeLive(record, record.expiresAt)).toBe(false);
  });

  it("stays dead afterwards", () => {
    expect(isDeviceCodeLive(record, record.expiresAt + 60_000)).toBe(false);
  });
});
