import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeOrRepair, repairMessage } from "../repair";
import { compileToGrid } from "../compile";
import {
  BOARD_COLS,
  BOARD_ROWS,
  MAX_SEGMENT_TEXT,
  decodeBoardGrid,
  decodeBoardMessage,
} from "@/lib/schemas/board";

/**
 * Adversarial shapes a model has plausibly handed back: wrong arity, wrong
 * types, invented colours, nested junk, prose instead of structure. Every one
 * must survive repair and compile to a renderable board.
 */
const fuzzCorpus: ReadonlyArray<unknown> = [
  undefined,
  null,
  42,
  true,
  "JUST A STRING",
  [],
  {},
  { rows: null },
  { rows: "ONE ROW" },
  { rows: {} },
  { rows: [null, undefined, 0, false] },
  { rows: ["A", "B", "C", "D", "E", "F", "G"] },
  { rows: Array.from({ length: 12 }, (_, i) => ({ segments: [{ text: `ROW ${i}` }] })) },
  { rows: [{ segments: "not an array" }] },
  { rows: [{ segments: [{ text: null, color: "chartreuse" }] }] },
  { rows: [{ align: "diagonal", segments: [{ text: "TILTED" }] }] },
  { rows: [{ segments: [{ text: "X".repeat(500) }] }] },
  { rows: [{ segments: Array.from({ length: 80 }, () => ({ text: "Y" })) }] },
  { rows: [{ segments: [{ text: { nested: { deeper: true } } }] }] },
  { rows: [{ text: "SHORTHAND ROW" }] },
  { rows: [[{ text: "ROW AS ARRAY" }]] },
  [{ segments: [{ text: "TOP LEVEL ARRAY" }] }],
  { rows: [{ segments: [{ text: "A".repeat(40) }] }], extra: "ignored" },
  { rows: [{ segments: [{ text: "OK", color: 7 }] }] },
];

describe("repairMessage — fuzz corpus", () => {
  it("always produces a message that decodes", () => {
    for (const input of fuzzCorpus) {
      const repaired = repairMessage(input);
      const decoded = decodeBoardMessage(repaired);
      expect(
        Either.isRight(decoded),
        `failed to decode repair of: ${JSON.stringify(input)}`
      ).toBe(true);
    }
  });

  it("always compiles to a valid 6x24 grid", () => {
    for (const input of fuzzCorpus) {
      const grid = compileToGrid(repairMessage(input));
      expect(grid.rows).toHaveLength(BOARD_ROWS);
      for (const row of grid.rows) expect(row).toHaveLength(BOARD_COLS);
      expect(
        Either.isRight(decodeBoardGrid(grid)),
        `invalid grid from: ${JSON.stringify(input)}`
      ).toBe(true);
    }
  });

  it("never throws", () => {
    for (const input of fuzzCorpus) {
      expect(() => repairMessage(input)).not.toThrow();
    }
  });
});

describe("repairMessage — coercions", () => {
  it("clips to six rows", () => {
    const repaired = repairMessage({
      rows: Array.from({ length: 10 }, (_, i) => ({ segments: [{ text: `R${i}` }] })),
    });
    expect(repaired.rows).toHaveLength(BOARD_ROWS);
    expect(repaired.rows[0]!.segments[0]!.text).toBe("R0");
  });

  it("clips to one segment per column", () => {
    const repaired = repairMessage({
      rows: [{ segments: Array.from({ length: 99 }, () => ({ text: "Z" })) }],
    });
    expect(repaired.rows[0]!.segments).toHaveLength(BOARD_COLS);
  });

  it("treats a bare string row as a single white segment", () => {
    const repaired = repairMessage({ rows: ["HELLO"] });
    expect(repaired.rows[0]!.segments).toEqual([{ text: "HELLO", color: "white" }]);
    expect(repaired.rows[0]!.align).toBe("left");
  });

  it("falls back to white for an invented colour", () => {
    const repaired = repairMessage({ rows: [{ segments: [{ text: "HI", color: "puce" }] }] });
    expect(repaired.rows[0]!.segments[0]!.color).toBe("white");
  });

  it("falls back to left for an invented alignment", () => {
    const repaired = repairMessage({ rows: [{ align: "sideways", segments: [] }] });
    expect(repaired.rows[0]!.align).toBe("left");
  });

  it("keeps spread, which is a real alignment and the one a model reaches for", () => {
    const repaired = repairMessage({
      rows: [{ align: "spread", segments: [{ text: "RAIN" }, { text: "30%" }] }],
    });
    expect(repaired.rows[0]!.align).toBe("spread");
    // Repaired or not, the row still ends flush against the right edge.
    const row = compileToGrid(repaired).rows[0]!;
    expect(row.map((cell) => cell.char).join("")).toBe(
      `RAIN${" ".repeat(17)}30%`
    );
  });

  it("clamps over-long text instead of rejecting it", () => {
    const repaired = repairMessage({ rows: [{ segments: [{ text: "Q".repeat(900) }] }] });
    expect(repaired.rows[0]!.segments[0]!.text).toHaveLength(MAX_SEGMENT_TEXT);
  });

  it("stringifies scalar text and empties structural text", () => {
    const scalar = repairMessage({ rows: [{ segments: [{ text: 2026 }] }] });
    expect(scalar.rows[0]!.segments[0]!.text).toBe("2026");

    const structural = repairMessage({ rows: [{ segments: [{ text: { a: 1 } }] }] });
    expect(structural.rows[0]!.segments[0]!.text).toBe("");
  });

  it("accepts a row's shorthand text field", () => {
    const repaired = repairMessage({ rows: [{ text: "SHORTHAND" }] });
    expect(repaired.rows[0]!.segments[0]!.text).toBe("SHORTHAND");
  });
});

describe("decodeOrRepair", () => {
  it("passes a valid message through untouched", () => {
    const input = {
      rows: [{ align: "center", segments: [{ text: "VALID", color: "yellow" }] }],
    };
    const result = decodeOrRepair(input);
    expect(result.repaired).toBe(false);
    expect(result.message.rows[0]!.segments[0]).toEqual({ text: "VALID", color: "yellow" });
  });

  it("applies schema defaults without counting as a repair", () => {
    const result = decodeOrRepair({ rows: [{ segments: [{ text: "DEFAULTS" }] }] });
    expect(result.repaired).toBe(false);
    expect(result.message.rows[0]!.align).toBe("left");
    expect(result.message.rows[0]!.segments[0]!.color).toBe("white");
  });

  it("flags a repair when the input cannot decode", () => {
    const result = decodeOrRepair({ rows: [{ segments: [{ text: "BAD", color: "neon" }] }] });
    expect(result.repaired).toBe(true);
    expect(result.message.rows[0]!.segments[0]!.color).toBe("white");
  });
});
