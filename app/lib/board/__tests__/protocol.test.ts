import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  BOARD_COLS,
  BOARD_ROWS,
  MAX_SEGMENT_TEXT,
  decodeBoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";
import {
  DEFAULT_SOUND_PACK,
  MAX_NONCE_LENGTH,
  MAX_NONCE_TTL_SECONDS,
  MAX_PROMPT_LENGTH,
  NONCE_KEY_PREFIX,
  applySet,
  applySettings,
  nonceKey,
  nonceSpendResult,
  parseSettingsPatch,
  parseSpendNonceRequest,
  commandFromUnknown,
  decodeRoomState,
  errorEvent,
  initialState,
  isStale,
  parseCommand,
  parseEvent,
  serializeEvent,
  stateEvent,
  type BoardRoomState,
  type SetCommand,
} from "../protocol";

const encode = (value: unknown): string => JSON.stringify(value);

const toBuffer = (text: string): ArrayBuffer => {
  const bytes = new TextEncoder().encode(text);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const message = (text: string): BoardMessage => ({
  rows: [{ align: "left", segments: [{ text, color: "white" }] }],
});

const setCommand = (
  overrides: Partial<SetCommand> = {}
): SetCommand => ({
  type: "set",
  baseRevision: 0,
  message: message("HELLO"),
  ...overrides,
});

const expectValidGrid = (state: BoardRoomState) => {
  const decoded = decodeBoardGrid(state.grid);
  expect(Either.isRight(decoded)).toBe(true);
  expect(state.grid.rows).toHaveLength(BOARD_ROWS);
  for (const row of state.grid.rows) expect(row).toHaveLength(BOARD_COLS);
};

describe("initialState", () => {
  it("starts at revision 0 on a blank unmuted classic board", () => {
    const state = initialState();
    expect(state.revision).toBe(0);
    expect(state.soundPack).toBe(DEFAULT_SOUND_PACK);
    expect(state.muted).toBe(false);
    expectValidGrid(state);
    expect(
      state.grid.rows.every((row) =>
        row.every((cell) => cell.char === " " && cell.color === "black")
      )
    ).toBe(true);
  });

  it("hands out a fresh grid each call (no shared mutable state)", () => {
    expect(initialState().grid).not.toBe(initialState().grid);
  });
});

describe("parseCommand — rejection", () => {
  const garbage: ReadonlyArray<string> = [
    "",
    "   ",
    "not json at all",
    "{",
    "{ type: 'set' }",
    "undefined",
    "NaN",
    "[1,2,3",
    '{"type":"set",}',
  ];

  it.each(garbage)("returns null for unparseable input %j", (raw) => {
    expect(parseCommand(raw)).toBeNull();
  });

  const wrongShapes: ReadonlyArray<unknown> = [
    null,
    42,
    true,
    "a bare string",
    [],
    [{ type: "hello" }],
    {},
    { type: null },
    { type: 7 },
    { type: "" },
    { type: "SET" },
    { type: "Hello" },
    { type: "flip" },
    { type: "state", revision: 1 },
    { type: "set" },
    { type: "set", baseRevision: 0 },
    { type: "set", baseRevision: 0, message: null },
    { type: "set", baseRevision: 0, message: undefined },
  ];

  it.each(wrongShapes)("returns null for wrong shape %j", (value) => {
    expect(parseCommand(encode(value))).toBeNull();
  });

  it("never throws for any of the above", () => {
    for (const raw of [...garbage, ...wrongShapes.map(encode)]) {
      expect(() => parseCommand(raw)).not.toThrow();
    }
  });
});

describe("parseCommand — acceptance", () => {
  it("parses hello", () => {
    expect(parseCommand(encode({ type: "hello" }))).toEqual({ type: "hello" });
  });

  it("ignores extra keys on hello", () => {
    expect(parseCommand(encode({ type: "hello", noise: 1 }))).toEqual({
      type: "hello",
    });
  });

  it("parses an ArrayBuffer payload identically to a string", () => {
    const raw = encode({ type: "hello" });
    expect(parseCommand(toBuffer(raw))).toEqual(parseCommand(raw));
  });

  it("parses a well-formed set command", () => {
    const command = parseCommand(
      encode({
        type: "set",
        baseRevision: 3,
        message: message("HELLO"),
        source: "llm",
        prompt: "say hi",
      })
    );
    expect(command).toEqual({
      type: "set",
      baseRevision: 3,
      message: message("HELLO"),
      source: "llm",
      prompt: "say hi",
    });
  });

  it("carries align: spread across the wire and lays it out on the board", () => {
    // `spread` is only useful if it survives the socket: the phone and the LLM
    // both author on one side of it and the TV compiles on the other.
    const raw = encode({
      type: "set",
      baseRevision: 0,
      message: {
        rows: [
          {
            align: "spread",
            segments: [
              { text: "RAIN", color: "white" },
              { text: "30%", color: "orange" },
            ],
          },
        ],
      },
    });
    const command = parseCommand(raw);
    if (command?.type !== "set") throw new Error("expected a set command");

    expect(command.message.rows[0]?.align).toBe("spread");

    const { state, truncated } = applySet(initialState(), command);
    const row = state.grid.rows[0]!;
    expect(row.map((cell) => cell.char).join("")).toBe(`RAIN${" ".repeat(17)}30%`);
    expect(row[23]).toEqual({ char: "%", color: "orange" });
    expect(truncated).toBe(false);
  });

  it("fills segment/row defaults through the message schema", () => {
    const command = parseCommand(
      encode({ type: "set", baseRevision: 0, message: { rows: [{ segments: [{ text: "A" }] }] } })
    );
    expect(command?.type).toBe("set");
    if (command?.type !== "set") throw new Error("unreachable");
    expect(command.message.rows[0]?.align).toBe("left");
    expect(command.message.rows[0]?.segments[0]?.color).toBe("white");
  });

  it("drops a source it does not recognise instead of failing", () => {
    const command = parseCommand(
      encode({ type: "set", baseRevision: 0, message: message("X"), source: "telepathy" })
    );
    if (command?.type !== "set") throw new Error("expected a set command");
    expect(command.source).toBeUndefined();
  });

  it("drops a non-string prompt and clamps a long one", () => {
    const dropped = parseCommand(
      encode({ type: "set", baseRevision: 0, message: message("X"), prompt: { a: 1 } })
    );
    if (dropped?.type !== "set") throw new Error("expected a set command");
    expect(dropped.prompt).toBeUndefined();

    const clamped = parseCommand(
      encode({
        type: "set",
        baseRevision: 0,
        message: message("X"),
        prompt: "P".repeat(MAX_PROMPT_LENGTH * 3),
      })
    );
    if (clamped?.type !== "set") throw new Error("expected a set command");
    expect(clamped.prompt).toHaveLength(MAX_PROMPT_LENGTH);
  });
});

describe("parseCommand — baseRevision normalization", () => {
  const cases: ReadonlyArray<readonly [unknown, number]> = [
    [0, 0],
    [7, 7],
    [undefined, 0],
    [null, 0],
    [-1, 0],
    [-9999, 0],
    ["12", 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [1.9, 1],
    [{}, 0],
    [[], 0],
    [true, 0],
  ];

  it.each(cases)("coerces %j to %i", (input, expected) => {
    const command = parseCommand(
      encode({ type: "set", baseRevision: input, message: message("X") })
    );
    if (command?.type !== "set") throw new Error("expected a set command");
    expect(command.baseRevision).toBe(expected);
  });
});

describe("parseCommand — message repair", () => {
  const sloppy: ReadonlyArray<unknown> = [
    "JUST A STRING",
    42,
    true,
    [],
    {},
    { rows: "ONE ROW" },
    { rows: [null, undefined, 0, false] },
    { rows: ["A", "B", "C", "D", "E", "F", "G", "H"] },
    { rows: [{ segments: "not an array" }] },
    { rows: [{ segments: [{ text: null, color: "chartreuse" }] }] },
    { rows: [{ align: "diagonal", segments: [{ text: "TILTED" }] }] },
    { rows: [{ segments: [{ text: "X".repeat(MAX_SEGMENT_TEXT * 4) }] }] },
    { rows: [{ text: "SHORTHAND ROW" }] },
    { rows: [[{ text: "ROW AS ARRAY" }]] },
    [{ segments: [{ text: "TOP LEVEL ARRAY" }] }],
  ];

  it.each(sloppy)("repairs %j into an applicable command", (payload) => {
    const command = parseCommand(
      encode({ type: "set", baseRevision: 0, message: payload })
    );
    if (command?.type !== "set") throw new Error("expected a set command");
    expectValidGrid(applySet(initialState(), command).state);
  });

  it("keeps the visible text when a lowercase/accented message is repaired", () => {
    const command = parseCommand(
      encode({ type: "set", baseRevision: 0, message: "café" })
    );
    if (command?.type !== "set") throw new Error("expected a set command");
    const { state } = applySet(initialState(), command);
    const text = state.grid.rows[0]!.map((cell) => cell.char).join("").trim();
    expect(text).toBe("CAFE");
  });
});

describe("commandFromUnknown", () => {
  it("accepts an already-decoded object without going through JSON", () => {
    expect(commandFromUnknown({ type: "hello" })).toEqual({ type: "hello" });
  });

  it("rejects a Map-like / class instance payload", () => {
    expect(commandFromUnknown(new Map())).toBeNull();
  });
});

describe("applySet", () => {
  it("increments the revision by exactly one and keeps settings", () => {
    const start: BoardRoomState = {
      ...initialState(),
      soundPack: "retro",
      muted: true,
    };
    const { state } = applySet(start, setCommand());
    expect(state.revision).toBe(1);
    expect(state.soundPack).toBe("retro");
    expect(state.muted).toBe(true);
  });

  it("is monotonic across a long run of writes", () => {
    let state = initialState();
    for (let i = 0; i < 50; i += 1) {
      const next = applySet(state, setCommand({ message: message(`MSG ${i}`) }));
      expect(next.state.revision).toBe(state.revision + 1);
      expectValidGrid(next.state);
      state = next.state;
    }
    expect(state.revision).toBe(50);
  });

  it("does not mutate the input state", () => {
    const start = initialState();
    const snapshot = JSON.stringify(start);
    applySet(start, setCommand());
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it("applies a stale baseRevision anyway — last write wins", () => {
    const first = applySet(initialState(), setCommand({ message: message("FIRST") })).state;
    const second = applySet(first, setCommand({ message: message("SECOND") })).state;
    const stale = setCommand({ baseRevision: 0, message: message("THIRD") });

    expect(isStale(second, stale)).toBe(true);
    const { state } = applySet(second, stale);
    expect(state.revision).toBe(3);
    expect(state.grid.rows[0]!.map((cell) => cell.char).join("").trim()).toBe(
      "THIRD"
    );
  });

  it("reports a fresh baseRevision as not stale", () => {
    const state = applySet(initialState(), setCommand()).state;
    expect(isStale(state, setCommand({ baseRevision: 1 }))).toBe(false);
    // A base ahead of the room (impossible but harmless) is not stale either.
    expect(isStale(state, setCommand({ baseRevision: 99 }))).toBe(false);
  });

  it("flags truncation when the message overflows the board", () => {
    const overflow: BoardMessage = {
      rows: Array.from({ length: BOARD_ROWS }, () => ({
        align: "left" as const,
        segments: [{ text: "WORD ".repeat(20), color: "white" as const }],
      })),
    };
    const { state, truncated } = applySet(
      initialState(),
      setCommand({ message: overflow })
    );
    expect(truncated).toBe(true);
    expectValidGrid(state);
  });

  it("does not flag truncation for a message that fits", () => {
    expect(applySet(initialState(), setCommand()).truncated).toBe(false);
  });

  it("always yields a valid 6x24 grid for every repaired fuzz payload", () => {
    const payloads: ReadonlyArray<unknown> = [
      undefined,
      null,
      "",
      "ONE LINE",
      { rows: [] },
      { rows: Array.from({ length: 40 }, (_, i) => ({ segments: [{ text: `R${i}` }] })) },
      { rows: [{ segments: Array.from({ length: 200 }, () => ({ text: "Z" })) }] },
      { rows: [{ segments: [{ text: " emoji 🎉 ünïcode" }] }] },
    ];
    for (const payload of payloads) {
      const command = commandFromUnknown({
        type: "set",
        baseRevision: 0,
        message: payload ?? "FALLBACK",
      });
      if (command?.type !== "set") throw new Error("expected a set command");
      expectValidGrid(applySet(initialState(), command).state);
    }
  });
});

describe("events", () => {
  it("omits truncated unless it is true", () => {
    const state = initialState();
    expect(stateEvent(state)).not.toHaveProperty("truncated");
    expect(stateEvent(state, false)).not.toHaveProperty("truncated");
    expect(stateEvent(state, true).truncated).toBe(true);
  });

  it("round-trips a state event through serialize/parse", () => {
    const { state, truncated } = applySet(initialState(), setCommand());
    const event = stateEvent(state, truncated);
    const parsed = parseEvent(serializeEvent(event));
    expect(parsed).toEqual(event);
  });

  it("round-trips an error event", () => {
    for (const code of ["invalid_command", "persist_failed"] as const) {
      const parsed = parseEvent(serializeEvent(errorEvent(code)));
      expect(parsed).toEqual({ type: "error", code });
    }
  });

  it("round-trips through an ArrayBuffer frame", () => {
    const event = stateEvent(initialState());
    expect(parseEvent(toBuffer(serializeEvent(event)))).toEqual(event);
  });

  it("returns null for events it cannot trust", () => {
    expect(parseEvent("nonsense")).toBeNull();
    expect(parseEvent(encode({ type: "state" }))).toBeNull();
    expect(parseEvent(encode({ type: "error", code: "kaput" }))).toBeNull();
    expect(
      parseEvent(encode({ type: "state", revision: -1, grid: initialState().grid, soundPack: "classic", muted: false }))
    ).toBeNull();
  });
});

describe("decodeRoomState", () => {
  it("accepts what the reducer produces", () => {
    const { state } = applySet(initialState(), setCommand());
    expect(decodeRoomState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("rejects state that lost the 6x24 invariant or a field", () => {
    const state = initialState();
    expect(decodeRoomState(undefined)).toBeNull();
    expect(decodeRoomState({})).toBeNull();
    expect(decodeRoomState({ ...state, revision: 1.5 })).toBeNull();
    expect(decodeRoomState({ ...state, muted: "no" })).toBeNull();
    expect(
      decodeRoomState({ ...state, grid: { rows: state.grid.rows.slice(0, 3) } })
    ).toBeNull();
  });
});

describe("set command source (widened to every persisted source)", () => {
  const base = { type: "set", baseRevision: 0, message: { rows: [] } };

  it("keeps manual and llm", () => {
    expect(parseCommand(JSON.stringify({ ...base, source: "manual" }))).toMatchObject({
      source: "manual",
    });
    expect(parseCommand(JSON.stringify({ ...base, source: "llm" }))).toMatchObject({
      source: "llm",
    });
  });

  it("keeps automation rather than silently relabelling it as manual", () => {
    // Regression: the wire used to accept only manual|llm while the
    // board_snapshot.source column accepted automation too, so an automation
    // write would have been persisted as `manual` — a silent mislabel in
    // history. Nothing writes automation yet; the enum still has to round-trip.
    expect(parseCommand(JSON.stringify({ ...base, source: "automation" }))).toMatchObject({
      source: "automation",
    });
  });

  it("still drops a source that is not a real persisted source", () => {
    expect(parseCommand(JSON.stringify({ ...base, source: "telepathy" }))).not.toHaveProperty(
      "source"
    );
    expect(parseCommand(JSON.stringify({ ...base, source: 7 }))).not.toHaveProperty("source");
  });
});

/* -------------------------------------------------------------------------- */
/* Control plane — settings                                                   */
/* -------------------------------------------------------------------------- */

describe("parseSettingsPatch", () => {
  it("accepts a pack-only and a mute-only patch", () => {
    expect(parseSettingsPatch(JSON.stringify({ soundPack: "vintage" }))).toEqual({
      soundPack: "vintage",
    });
    expect(parseSettingsPatch(JSON.stringify({ muted: true }))).toEqual({
      muted: true,
    });
  });

  it("accepts an empty patch — a no-op is not an error", () => {
    expect(parseSettingsPatch("{}")).toEqual({});
  });

  it("rejects junk rather than guessing", () => {
    expect(parseSettingsPatch("not json")).toBeNull();
    expect(parseSettingsPatch("[]")).toBeNull();
    expect(parseSettingsPatch(JSON.stringify({ muted: "yes" }))).toBeNull();
    expect(parseSettingsPatch(JSON.stringify({ soundPack: "" }))).toBeNull();
    expect(parseSettingsPatch(JSON.stringify({ soundPack: "x".repeat(64) }))).toBeNull();
  });

  it("reads a patch out of an ArrayBuffer frame", () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ muted: true }));
    expect(parseSettingsPatch(bytes.buffer as ArrayBuffer)).toEqual({ muted: true });
  });
});

describe("applySettings", () => {
  const base: BoardRoomState = {
    ...initialState(),
    revision: 7,
    soundPack: "classic",
    muted: false,
  };

  it("never touches the revision — a settings change is not a grid generation", () => {
    // This is the whole reason `shouldApplyState` applies *equal* revisions: a
    // settings-only frame has to reach the TV without minting a new revision.
    expect(applySettings(base, { muted: true }).revision).toBe(7);
    expect(applySettings(base, { soundPack: "vintage" }).revision).toBe(7);
    expect(applySettings(base, {}).revision).toBe(7);
  });

  it("never touches the grid", () => {
    expect(applySettings(base, { muted: true }).grid).toBe(base.grid);
  });

  it("applies only the fields present — absent means leave it alone", () => {
    expect(applySettings(base, { muted: true })).toEqual({
      ...base,
      muted: true,
    });
    expect(applySettings({ ...base, muted: true }, { soundPack: "vintage" })).toEqual({
      ...base,
      muted: true,
      soundPack: "vintage",
    });
  });

  it("an empty patch is an exact no-op", () => {
    expect(applySettings(base, {})).toEqual(base);
  });

  it("can turn mute back off (a false is applied, not read as absent)", () => {
    expect(applySettings({ ...base, muted: true }, { muted: false }).muted).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Control plane — nonce ledger                                               */
/* -------------------------------------------------------------------------- */

describe("parseSpendNonceRequest", () => {
  it("accepts a well-formed spend", () => {
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: "abc", ttlSeconds: 120 }))).toEqual({
      nonce: "abc",
      ttlSeconds: 120,
    });
  });

  it("rejects a missing or empty nonce", () => {
    expect(parseSpendNonceRequest(JSON.stringify({ ttlSeconds: 120 }))).toBeNull();
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: "", ttlSeconds: 120 }))).toBeNull();
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: 7, ttlSeconds: 120 }))).toBeNull();
  });

  it("bounds the nonce length so an unbounded key never reaches DO storage", () => {
    const ok = "a".repeat(MAX_NONCE_LENGTH);
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: ok, ttlSeconds: 1 }))).not.toBeNull();
    expect(
      parseSpendNonceRequest(JSON.stringify({ nonce: `${ok}a`, ttlSeconds: 1 }))
    ).toBeNull();
  });

  it("bounds the TTL at both ends", () => {
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: "a", ttlSeconds: 0 }))).toBeNull();
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: "a", ttlSeconds: -1 }))).toBeNull();
    expect(parseSpendNonceRequest(JSON.stringify({ nonce: "a", ttlSeconds: 1.5 }))).toBeNull();
    expect(
      parseSpendNonceRequest(JSON.stringify({ nonce: "a", ttlSeconds: MAX_NONCE_TTL_SECONDS }))
    ).not.toBeNull();
    expect(
      parseSpendNonceRequest(
        JSON.stringify({ nonce: "a", ttlSeconds: MAX_NONCE_TTL_SECONDS + 1 })
      )
    ).toBeNull();
  });

  it("rejects junk", () => {
    expect(parseSpendNonceRequest("nope")).toBeNull();
    expect(parseSpendNonceRequest("null")).toBeNull();
    expect(parseSpendNonceRequest("[]")).toBeNull();
  });
});

describe("nonceKey", () => {
  it("namespaces every ledger key under one prefix so pruning can scan just those", () => {
    expect(nonceKey("abc")).toBe(`${NONCE_KEY_PREFIX}abc`);
    expect(nonceKey("abc").startsWith(NONCE_KEY_PREFIX)).toBe(true);
  });

  it("cannot collide with the room's own state keys", () => {
    expect(nonceKey("board:state")).not.toBe("board:state");
    expect(nonceKey("board:id")).not.toBe("board:id");
  });
});

describe("nonceSpendResult", () => {
  it("is a tagged answer, so a caller can tell it from a state frame", () => {
    expect(nonceSpendResult(true)).toEqual({ type: "nonce", spent: true });
    expect(nonceSpendResult(false)).toEqual({ type: "nonce", spent: false });
  });
});

describe("the socket command union excludes control-plane requests", () => {
  it("a settings patch is not a BoardCommand", () => {
    // Settings are authorised at the HTTP boundary; a socket that is already open
    // must not be able to reconfigure the board.
    expect(parseCommand(JSON.stringify({ type: "settings", muted: true }))).toBeNull();
  });

  it("a nonce spend is not a BoardCommand", () => {
    // Far more important: a socket must never be able to burn or probe a pairing
    // nonce.
    expect(
      parseCommand(JSON.stringify({ type: "spend-nonce", nonce: "abc", ttlSeconds: 120 }))
    ).toBeNull();
  });
});
