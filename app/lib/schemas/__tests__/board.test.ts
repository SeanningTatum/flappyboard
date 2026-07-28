import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  BLANK_COLOR,
  BOARD_CHARS,
  BOARD_COLORS,
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_COLOR,
  decodeBoardGrid,
  decodeBoardMessage,
  decodeRouterDecision,
  isBoardChar,
} from "../board";

const cell = { char: "A", color: "white" } as const;
const row = Array.from({ length: BOARD_COLS }, () => cell);

describe("board constants", () => {
  it("is a 6 by 24 board", () => {
    expect(BOARD_ROWS).toBe(6);
    expect(BOARD_COLS).toBe(24);
  });

  it("has a blank-safe default palette", () => {
    expect(BOARD_COLORS).toContain(DEFAULT_COLOR);
    expect(BOARD_COLORS).toContain(BLANK_COLOR);
    expect(BOARD_CHARS.startsWith(" ")).toBe(true);
  });
});

describe("isBoardChar", () => {
  it("accepts every character in the flap set", () => {
    for (const char of BOARD_CHARS) expect(isBoardChar(char)).toBe(true);
  });

  it("rejects lowercase, emoji, and multi-character strings", () => {
    expect(isBoardChar("a")).toBe(false);
    expect(isBoardChar("🎉")).toBe(false);
    expect(isBoardChar("AB")).toBe(false);
    expect(isBoardChar("")).toBe(false);
  });
});

describe("BoardGrid", () => {
  it("accepts exactly 6 rows of 24 cells", () => {
    const grid = { rows: Array.from({ length: BOARD_ROWS }, () => row) };
    expect(Either.isRight(decodeBoardGrid(grid))).toBe(true);
  });

  it("rejects the wrong row count", () => {
    const grid = { rows: Array.from({ length: 5 }, () => row) };
    expect(Either.isLeft(decodeBoardGrid(grid))).toBe(true);
  });

  it("rejects a short row", () => {
    const grid = {
      rows: [row, row, row, row, row, row.slice(0, 23)],
    };
    expect(Either.isLeft(decodeBoardGrid(grid))).toBe(true);
  });

  it("rejects a character no flap can show", () => {
    const bad = [{ char: "a", color: "white" }, ...row.slice(1)];
    const grid = { rows: [bad, row, row, row, row, row] };
    expect(Either.isLeft(decodeBoardGrid(grid))).toBe(true);
  });
});

describe("BoardMessage", () => {
  it("defaults align to left and colour to white", () => {
    const decoded = decodeBoardMessage({ rows: [{ segments: [{ text: "HI" }] }] });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.rows[0]!.align).toBe("left");
      expect(decoded.right.rows[0]!.segments[0]!.color).toBe("white");
    }
  });

  it("accepts spread, the alignment a label/value row needs", () => {
    const decoded = decodeBoardMessage({
      rows: [
        { align: "spread", segments: [{ text: "RAIN" }, { text: "30%" }] },
      ],
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.rows[0]!.align).toBe("spread");
    }
  });

  it("rejects an alignment that is not one of the four", () => {
    expect(
      Either.isLeft(
        decodeBoardMessage({ rows: [{ align: "justify", segments: [] }] })
      )
    ).toBe(true);
  });

  it("rejects more than six rows", () => {
    const rows = Array.from({ length: 7 }, () => ({ segments: [{ text: "X" }] }));
    expect(Either.isLeft(decodeBoardMessage({ rows }))).toBe(true);
  });

  it("rejects an unknown colour", () => {
    const decoded = decodeBoardMessage({
      rows: [{ segments: [{ text: "X", color: "beige" }] }],
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  it("accepts an empty board", () => {
    expect(Either.isRight(decodeBoardMessage({ rows: [] }))).toBe(true);
  });
});

/**
 * The router's reply gates whether the search tool is attached, and the agent
 * falls open to searching on a decode failure. So the property that matters is
 * that a *truthy* answer is not accepted as a *true* one — coercion here would
 * silently route every malformed reply to the expensive branch.
 */
describe("decodeRouterDecision", () => {
  it("accepts either boolean", () => {
    const yes = decodeRouterDecision({ needs_live_data: true });
    const no = decodeRouterDecision({ needs_live_data: false });
    expect(Either.isRight(yes)).toBe(true);
    expect(Either.isRight(no)).toBe(true);
    if (Either.isRight(yes)) expect(yes.right.needs_live_data).toBe(true);
    if (Either.isRight(no)) expect(no.right.needs_live_data).toBe(false);
  });

  it.each([
    ["a truthy string", "yes"],
    ["a falsy string", ""],
    ["a truthy number", 1],
    ["zero", 0],
    ["null", null],
  ])("rejects %s rather than coercing it", (_label, value) => {
    expect(
      Either.isLeft(decodeRouterDecision({ needs_live_data: value }))
    ).toBe(true);
  });

  it("rejects a missing field", () => {
    expect(Either.isLeft(decodeRouterDecision({}))).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(Either.isLeft(decodeRouterDecision("true"))).toBe(true);
  });
});
