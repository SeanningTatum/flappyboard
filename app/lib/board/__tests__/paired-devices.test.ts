import { describe, expect, it } from "vitest";

import { MAX_NONCE_LENGTH } from "../protocol";
import {
  GRANT_KEY_PREFIX,
  MAX_DEVICE_NAME_LENGTH,
  MAX_GRANT_TTL_SECONDS,
  MAX_PAIRED_DEVICES,
  REVOKED_KEY_PREFIX,
  decodePairedDevice,
  decideTouch,
  grantKey,
  grantRevokeResult,
  grantTouchResult,
  normalizeDeviceName,
  overflowVictims,
  pairedDeviceList,
  parseGrantRevoke,
  parseGrantTouch,
  parsePairedDevices,
  parseRecordGrantRequest,
  parseRevokeGrantRequest,
  parseTouchGrantRequest,
  pruneDevices,
  renewRecord,
  revokedKey,
  type PairedDeviceRecord,
} from "../paired-devices";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const record = (
  overrides: Partial<PairedDeviceRecord> = {}
): PairedDeviceRecord => ({
  nonce: "n-1",
  name: "Kai's phone",
  issuedAt: NOW - DAY,
  lastSeenAt: NOW - 1000,
  expiresAt: NOW + 30 * DAY,
  ...overrides,
});

describe("storage keys", () => {
  it("prefixes records and tombstones so each can be scanned alone", () => {
    expect(grantKey("abc")).toBe(`${GRANT_KEY_PREFIX}abc`);
    expect(revokedKey("abc")).toBe(`${REVOKED_KEY_PREFIX}abc`);
  });

  it("keeps the two key spaces apart for the same nonce", () => {
    // Load-bearing: deleting a record must never be able to delete the
    // tombstone that refuses it.
    expect(grantKey("abc")).not.toBe(revokedKey("abc"));
    expect(grantKey("abc").startsWith(REVOKED_KEY_PREFIX)).toBe(false);
    expect(revokedKey("abc").startsWith(GRANT_KEY_PREFIX)).toBe(false);
  });

  it("gives distinct nonces distinct keys", () => {
    expect(grantKey("a")).not.toBe(grantKey("b"));
    expect(revokedKey("a")).not.toBe(revokedKey("b"));
  });
});

describe("decodePairedDevice", () => {
  it("accepts a well-formed record", () => {
    expect(decodePairedDevice(record())).toEqual(record());
  });

  it("accepts an unnamed device — naming is optional, not a failure", () => {
    expect(decodePairedDevice(record({ name: null }))).toEqual(
      record({ name: null })
    );
  });

  it("refuses anything that is not a well-formed record", () => {
    for (const bad of [
      undefined,
      null,
      42,
      "record",
      [],
      {},
      record({ nonce: "" }),
      { ...record(), name: 7 },
      { ...record(), name: undefined },
      { ...record(), issuedAt: "yesterday" },
      { ...record(), lastSeenAt: 1.5 },
      { ...record(), expiresAt: -1 },
      { ...record(), nonce: "n".repeat(MAX_NONCE_LENGTH + 1) },
      { ...record(), name: "x".repeat(MAX_DEVICE_NAME_LENGTH + 1) },
    ]) {
      expect(decodePairedDevice(bad)).toBeNull();
    }
  });
});

describe("normalizeDeviceName", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeDeviceName("  Kai's   phone  ")).toBe("Kai's phone");
  });

  it("truncates to the storage ceiling", () => {
    const long = "x".repeat(200);
    const normalized = normalizeDeviceName(long);
    expect(normalized).toHaveLength(MAX_DEVICE_NAME_LENGTH);
    expect(normalized).toBe("x".repeat(MAX_DEVICE_NAME_LENGTH));
  });

  it("counts characters after collapsing, not before", () => {
    const spaced = "a b".repeat(40).replace(/ /g, "     ");
    const normalized = normalizeDeviceName(spaced);
    expect(normalized).toHaveLength(MAX_DEVICE_NAME_LENGTH);
    expect(normalized).not.toContain("  ");
  });

  it("returns null for an empty or whitespace-only name", () => {
    expect(normalizeDeviceName("")).toBeNull();
    expect(normalizeDeviceName("   ")).toBeNull();
    expect(normalizeDeviceName("\t\n ")).toBeNull();
  });

  it("returns null for a non-string, rather than inventing a name", () => {
    for (const bad of [undefined, null, 42, {}, [], true]) {
      expect(normalizeDeviceName(bad)).toBeNull();
    }
  });

  it("produces something the record schema accepts", () => {
    const name = normalizeDeviceName("y".repeat(500));
    expect(decodePairedDevice(record({ name }))).not.toBeNull();
  });
});

describe("decideTouch", () => {
  it("treats an absent record as LIVE — the grandfathering rule", () => {
    // Every phone paired before this feature shipped is in exactly this state.
    // Reading absence as revocation would un-pair every household on deploy.
    expect(decideTouch({ record: null, revoked: false, now: NOW })).toEqual({
      live: true,
      name: null,
    });
  });

  it("refuses on a tombstone with no record", () => {
    expect(decideTouch({ record: null, revoked: true, now: NOW })).toEqual({
      live: false,
      name: null,
    });
  });

  it("refuses on a tombstone even when a record still exists", () => {
    // A revoke drops the record and writes the tombstone; a prune racing a
    // revoke can leave either behind. Neither ordering may change the answer.
    expect(
      decideTouch({ record: record(), revoked: true, now: NOW })
    ).toEqual({ live: false, name: null });
  });

  it("reports the recorded name when live", () => {
    expect(
      decideTouch({ record: record(), revoked: false, now: NOW })
    ).toEqual({ live: true, name: "Kai's phone" });
  });

  it("reports a null name for a live but unnamed device", () => {
    expect(
      decideTouch({ record: record({ name: null }), revoked: false, now: NOW })
    ).toEqual({ live: true, name: null });
  });

  it("still reports an EXPIRED record as live", () => {
    // The record's expiresAt is pruning metadata. Grant expiry is judged by the
    // token's own signed expiresAt; duplicating it here would be two clocks.
    const stale = record({ expiresAt: NOW - 1 });
    expect(decideTouch({ record: stale, revoked: false, now: NOW })).toEqual({
      live: true,
      name: "Kai's phone",
    });
  });

  it("ignores `now` entirely when there is no tombstone", () => {
    const stale = record({ expiresAt: 0, lastSeenAt: 0, issuedAt: 0 });
    for (const now of [0, NOW, NOW + 400 * DAY]) {
      expect(decideTouch({ record: stale, revoked: false, now }).live).toBe(
        true
      );
    }
  });
});

describe("renewRecord", () => {
  const ttl = 30 * 24 * 60 * 60;

  it("creates a record on first sight, stamping issuedAt with now", () => {
    const created = renewRecord({
      record: null,
      nonce: "n-9",
      name: "kitchen iPad",
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(created).toEqual({
      nonce: "n-9",
      name: "kitchen iPad",
      issuedAt: NOW,
      lastSeenAt: NOW,
      expiresAt: NOW + ttl * 1000,
    });
  });

  it("creates an unnamed record when no name was given", () => {
    const created = renewRecord({
      record: null,
      nonce: "n-9",
      name: null,
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(created.name).toBeNull();
  });

  it("preserves issuedAt across a renewal", () => {
    const existing = record({ issuedAt: NOW - 100 * DAY });
    const renewed = renewRecord({
      record: existing,
      nonce: existing.nonce,
      name: null,
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(renewed.issuedAt).toBe(NOW - 100 * DAY);
  });

  it("preserves a captured name when the renewal passes null", () => {
    // A touch carries no name at all. It must never blank what the owner typed.
    const renewed = renewRecord({
      record: record({ name: "Kai's phone" }),
      nonce: "n-1",
      name: null,
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(renewed.name).toBe("Kai's phone");
  });

  it("keeps the original name even when a renewal offers a different one", () => {
    const renewed = renewRecord({
      record: record({ name: "Kai's phone" }),
      nonce: "n-1",
      name: "somebody else's phone",
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(renewed.name).toBe("Kai's phone");
  });

  it("lets a never-named record gain a name later", () => {
    const renewed = renewRecord({
      record: record({ name: null }),
      nonce: "n-1",
      name: "kitchen iPad",
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(renewed.name).toBe("kitchen iPad");
  });

  it("always slides lastSeenAt and expiresAt forward", () => {
    const existing = record({ lastSeenAt: NOW - 10 * DAY, expiresAt: NOW + 1 });
    const renewed = renewRecord({
      record: existing,
      nonce: existing.nonce,
      name: null,
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(renewed.lastSeenAt).toBe(NOW);
    expect(renewed.expiresAt).toBe(NOW + ttl * 1000);
  });

  it("renews an already-expired record rather than refusing it", () => {
    const dead = record({ expiresAt: NOW - DAY });
    const renewed = renewRecord({
      record: dead,
      nonce: dead.nonce,
      name: null,
      now: NOW,
      ttlSeconds: ttl,
    });
    expect(renewed.expiresAt).toBeGreaterThan(NOW);
  });

  it("produces a record the schema accepts", () => {
    const created = renewRecord({
      record: null,
      nonce: "n-9",
      name: normalizeDeviceName("  Kai's   phone "),
      now: NOW,
      ttlSeconds: MAX_GRANT_TTL_SECONDS,
    });
    expect(decodePairedDevice(created)).toEqual(created);
  });
});

describe("pruneDevices", () => {
  it("returns nothing when every entry is live and readable", () => {
    const entries = [
      [grantKey("a"), record({ nonce: "a" })],
      [grantKey("b"), record({ nonce: "b" })],
    ] as const;
    expect(pruneDevices(entries, NOW)).toEqual({ dead: [] });
  });

  it("drops entries that no longer decode", () => {
    const entries = [
      [grantKey("a"), record({ nonce: "a" })],
      [grantKey("junk"), { nonce: "junk" }],
      [grantKey("worse"), "not even an object"],
      [grantKey("null"), null],
    ] as const;
    expect(pruneDevices(entries, NOW).dead).toEqual([
      grantKey("junk"),
      grantKey("worse"),
      grantKey("null"),
    ]);
  });

  it("drops expired entries and keeps live ones", () => {
    const entries = [
      [grantKey("live"), record({ nonce: "live", expiresAt: NOW + 1 })],
      [grantKey("dead"), record({ nonce: "dead", expiresAt: NOW - 1 })],
    ] as const;
    expect(pruneDevices(entries, NOW).dead).toEqual([grantKey("dead")]);
  });

  it("treats expiry exactly at now as dead", () => {
    const entries = [
      [grantKey("edge"), record({ nonce: "edge", expiresAt: NOW })],
    ] as const;
    expect(pruneDevices(entries, NOW).dead).toEqual([grantKey("edge")]);
  });

  it("returns the key verbatim, not one rebuilt from the decoded nonce", () => {
    // An undecodable entry has no nonce to rebuild from, and a record whose
    // nonce disagreed with its key would otherwise be immortal.
    const entries = [
      ["legacy-key", record({ nonce: "different", expiresAt: NOW - 1 })],
    ] as const;
    expect(pruneDevices(entries, NOW).dead).toEqual(["legacy-key"]);
  });

  it("handles an empty scan", () => {
    expect(pruneDevices([], NOW)).toEqual({ dead: [] });
  });
});

describe("overflowVictims", () => {
  const seen = (nonce: string, lastSeenAt: number, issuedAt = 0) =>
    record({ nonce, lastSeenAt, issuedAt });

  it("evicts nothing under the limit", () => {
    expect(overflowVictims([seen("a", 1), seen("b", 2)], 3)).toEqual([]);
  });

  it("evicts nothing exactly at the limit", () => {
    expect(overflowVictims([seen("a", 1), seen("b", 2)], 2)).toEqual([]);
  });

  it("evicts nothing from an empty board", () => {
    expect(overflowVictims([], MAX_PAIRED_DEVICES)).toEqual([]);
  });

  it("evicts exactly the overflow count", () => {
    const records = Array.from({ length: 10 }, (_, i) => seen(`n-${i}`, i));
    expect(overflowVictims(records, 4)).toHaveLength(6);
    expect(overflowVictims(records, 9)).toHaveLength(1);
  });

  it("evicts the oldest-seen devices first", () => {
    const records = [
      seen("recent", NOW),
      seen("ancient", NOW - 100 * DAY),
      seen("old", NOW - 10 * DAY),
    ];
    expect(overflowVictims(records, 1)).toEqual(["ancient", "old"]);
  });

  it("never evicts the most recently seen device", () => {
    const records = Array.from({ length: 5 }, (_, i) => seen(`n-${i}`, i));
    expect(overflowVictims(records, 1)).not.toContain("n-4");
  });

  it("breaks lastSeenAt ties by issuedAt, then by nonce", () => {
    const records = [
      seen("b", NOW, 5),
      seen("a", NOW, 5),
      seen("c", NOW, 1),
      seen("keep", NOW + 1, 9),
    ];
    expect(overflowVictims(records, 1)).toEqual(["c", "a", "b"]);
  });

  it("is deterministic under input reordering", () => {
    const records = [
      seen("b", NOW, 5),
      seen("a", NOW, 5),
      seen("c", NOW, 1),
      seen("d", NOW - 1, 0),
    ];
    const forward = overflowVictims(records, 2);
    const backward = overflowVictims([...records].reverse(), 2);
    expect(forward).toEqual(backward);
    expect(forward).toEqual(["d", "c"]);
  });

  it("does not mutate its input", () => {
    const records = [seen("b", 2), seen("a", 1)];
    overflowVictims(records, 1);
    expect(records.map((r) => r.nonce)).toEqual(["b", "a"]);
  });
});

describe("parseRecordGrantRequest", () => {
  const valid = { nonce: "abc", name: "Kai's phone", ttlSeconds: 3600 };

  it("round-trips a well-formed body", () => {
    expect(parseRecordGrantRequest(JSON.stringify(valid))).toEqual(valid);
  });

  it("accepts an ArrayBuffer body", () => {
    const buffer = new TextEncoder().encode(JSON.stringify(valid)).buffer;
    expect(parseRecordGrantRequest(buffer as ArrayBuffer)).toEqual(valid);
  });

  it("accepts a body with no name — naming is optional", () => {
    expect(
      parseRecordGrantRequest(JSON.stringify({ nonce: "abc", ttlSeconds: 60 }))
    ).toEqual({ nonce: "abc", ttlSeconds: 60 });
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseRecordGrantRequest("{not json")).toBeNull();
    expect(parseRecordGrantRequest("")).toBeNull();
    expect(parseRecordGrantRequest("null")).toBeNull();
  });

  it("rejects wrong types", () => {
    for (const bad of [
      { ...valid, nonce: 42 },
      { ...valid, name: 42 },
      { ...valid, ttlSeconds: "3600" },
      { ...valid, ttlSeconds: 60.5 },
      ["abc", 3600],
      "abc",
    ]) {
      expect(parseRecordGrantRequest(JSON.stringify(bad))).toBeNull();
    }
  });

  it("rejects a missing nonce or ttl", () => {
    expect(parseRecordGrantRequest(JSON.stringify({ ttlSeconds: 60 }))).toBeNull();
    expect(parseRecordGrantRequest(JSON.stringify({ nonce: "abc" }))).toBeNull();
  });

  it("rejects an out-of-range ttl", () => {
    for (const ttlSeconds of [0, -1, MAX_GRANT_TTL_SECONDS + 1]) {
      expect(
        parseRecordGrantRequest(JSON.stringify({ ...valid, ttlSeconds }))
      ).toBeNull();
    }
    expect(
      parseRecordGrantRequest(
        JSON.stringify({ ...valid, ttlSeconds: MAX_GRANT_TTL_SECONDS })
      )
    ).not.toBeNull();
  });

  it("rejects an empty or over-long nonce", () => {
    expect(
      parseRecordGrantRequest(JSON.stringify({ ...valid, nonce: "" }))
    ).toBeNull();
    expect(
      parseRecordGrantRequest(
        JSON.stringify({ ...valid, nonce: "n".repeat(MAX_NONCE_LENGTH + 1) })
      )
    ).toBeNull();
  });

  it("rejects an over-long name rather than silently truncating it", () => {
    // The caller normalises with normalizeDeviceName before sending, so an
    // over-long name means a caller that skipped that step, not a long name.
    expect(
      parseRecordGrantRequest(
        JSON.stringify({
          ...valid,
          name: "x".repeat(MAX_DEVICE_NAME_LENGTH + 1),
        })
      )
    ).toBeNull();
  });
});

describe("parseTouchGrantRequest", () => {
  const valid = { nonce: "abc", ttlSeconds: 3600 };

  it("round-trips a well-formed body", () => {
    expect(parseTouchGrantRequest(JSON.stringify(valid))).toEqual(valid);
  });

  it("accepts an ArrayBuffer body", () => {
    const buffer = new TextEncoder().encode(JSON.stringify(valid)).buffer;
    expect(parseTouchGrantRequest(buffer as ArrayBuffer)).toEqual(valid);
  });

  it("gives a touch no way to carry a name", () => {
    // The whole point of the shape: a touch must not be able to rewrite a name.
    const smuggled = parseTouchGrantRequest(
      JSON.stringify({ ...valid, name: "hijacked" })
    );
    expect(smuggled).toEqual(valid);
    expect(smuggled && "name" in smuggled).toBe(false);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseTouchGrantRequest("{not json")).toBeNull();
    expect(parseTouchGrantRequest("")).toBeNull();
  });

  it("rejects wrong types and a missing field", () => {
    for (const bad of [
      { nonce: 42, ttlSeconds: 60 },
      { nonce: "abc", ttlSeconds: "60" },
      { nonce: "abc" },
      { ttlSeconds: 60 },
      42,
    ]) {
      expect(parseTouchGrantRequest(JSON.stringify(bad))).toBeNull();
    }
  });

  it("rejects an out-of-range ttl", () => {
    for (const ttlSeconds of [0, -1, 1.5, MAX_GRANT_TTL_SECONDS + 1]) {
      expect(
        parseTouchGrantRequest(JSON.stringify({ ...valid, ttlSeconds }))
      ).toBeNull();
    }
  });

  it("rejects an over-long nonce", () => {
    expect(
      parseTouchGrantRequest(
        JSON.stringify({ ...valid, nonce: "n".repeat(MAX_NONCE_LENGTH + 1) })
      )
    ).toBeNull();
  });
});

describe("parseRevokeGrantRequest", () => {
  it("round-trips a well-formed body", () => {
    expect(parseRevokeGrantRequest(JSON.stringify({ nonce: "abc" }))).toEqual({
      nonce: "abc",
    });
  });

  it("accepts an ArrayBuffer body", () => {
    const buffer = new TextEncoder().encode(JSON.stringify({ nonce: "abc" }))
      .buffer;
    expect(parseRevokeGrantRequest(buffer as ArrayBuffer)).toEqual({
      nonce: "abc",
    });
  });

  it("carries no ttl — a tombstone outlives the grant it refuses", () => {
    const parsed = parseRevokeGrantRequest(
      JSON.stringify({ nonce: "abc", ttlSeconds: 1 })
    );
    expect(parsed).toEqual({ nonce: "abc" });
    expect(parsed && "ttlSeconds" in parsed).toBe(false);
  });

  it("rejects invalid JSON without throwing", () => {
    expect(parseRevokeGrantRequest("{not json")).toBeNull();
    expect(parseRevokeGrantRequest("")).toBeNull();
  });

  it("rejects a missing, empty, wrongly-typed or over-long nonce", () => {
    for (const bad of [
      {},
      { nonce: "" },
      { nonce: 42 },
      { nonce: null },
      { nonce: "n".repeat(MAX_NONCE_LENGTH + 1) },
    ]) {
      expect(parseRevokeGrantRequest(JSON.stringify(bad))).toBeNull();
    }
  });
});

describe("parseGrantTouch", () => {
  it("round-trips the room's answer", () => {
    expect(parseGrantTouch(grantTouchResult(true, "Kai's phone"))).toEqual({
      live: true,
      name: "Kai's phone",
    });
    expect(parseGrantTouch(grantTouchResult(false, null))).toEqual({
      live: false,
      name: null,
    });
  });

  it("returns null on an unrecognised payload rather than guessing dead", () => {
    // Reading a shape mismatch as live:false would turn a deploy skew into a
    // house-wide un-pairing that looks exactly like a deliberate revoke.
    for (const bad of [
      undefined,
      null,
      42,
      [],
      {},
      { type: "nonce", spent: true },
      { live: true, name: null },
      { type: "grant-touch", name: null },
      { type: "grant-touch", live: "yes", name: null },
      { type: "grant-touch", live: true },
      { type: "grant-touch", live: true, name: 7 },
    ]) {
      expect(parseGrantTouch(bad)).toBeNull();
    }
  });
});

describe("parsePairedDevices", () => {
  it("round-trips a list of devices", () => {
    const devices = [record({ nonce: "a" }), record({ nonce: "b" })];
    expect(parsePairedDevices(pairedDeviceList(devices))).toEqual(devices);
  });

  it("round-trips an empty list", () => {
    expect(parsePairedDevices(pairedDeviceList([]))).toEqual([]);
  });

  it("returns null on an unrecognised payload", () => {
    for (const bad of [
      undefined,
      null,
      42,
      [],
      {},
      { type: "grant-touch", live: true, name: null },
      { devices: [] },
      { type: "paired-devices" },
      { type: "paired-devices", devices: {} },
      { type: "paired-devices", devices: [{ nonce: "a" }] },
    ]) {
      expect(parsePairedDevices(bad)).toBeNull();
    }
  });
});

describe("parseGrantRevoke", () => {
  it("round-trips the room's answer", () => {
    expect(parseGrantRevoke(grantRevokeResult(true))).toBe(true);
    expect(parseGrantRevoke(grantRevokeResult(false))).toBe(false);
  });

  it("returns null on an unrecognised payload", () => {
    for (const bad of [
      undefined,
      null,
      42,
      [],
      {},
      { revoked: true },
      { type: "nonce", spent: true },
      { type: "grant-revoke" },
      { type: "grant-revoke", revoked: "yes" },
    ]) {
      expect(parseGrantRevoke(bad)).toBeNull();
    }
  });
});

describe("bounds", () => {
  it("keeps the device-name ceiling inside what a record accepts", () => {
    const name = "x".repeat(MAX_DEVICE_NAME_LENGTH);
    expect(decodePairedDevice(record({ name }))).not.toBeNull();
  });

  it("keeps the storage bound plausible for a household", () => {
    expect(Number.isInteger(MAX_PAIRED_DEVICES)).toBe(true);
    expect(MAX_PAIRED_DEVICES).toBeGreaterThanOrEqual(8);
  });

  it("caps the remembered TTL at the browser Max-Age ceiling", () => {
    expect(MAX_GRANT_TTL_SECONDS).toBe(400 * 24 * 60 * 60);
  });
});
