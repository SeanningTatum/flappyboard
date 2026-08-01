import { describe, expect, it } from "vitest";
import { Either } from "effect";

import {
  BLANK_GRID,
  BOARD_CAPACITY,
  OPENING_GRID,
  OPENING_TEXT,
  typedBoard,
} from "../landing-board";
import {
  BOARD_COLS,
  BOARD_ROWS,
  decodeBoardGrid,
  isBoardChar,
} from "@/lib/schemas/board";

/** A grid back as flat text, the way a reader sees it. */
const text = (grid: { rows: ReadonlyArray<ReadonlyArray<{ char: string }>> }) =>
  grid.rows.map((row) => row.map((cell) => cell.char).join("")).join("\n");

describe("the landing board's opening message", () => {
  it("is a legal 6 × 24 grid", () => {
    expect(Either.isRight(decodeBoardGrid(OPENING_GRID))).toBe(true);
    expect(OPENING_GRID.rows).toHaveLength(BOARD_ROWS);
    for (const row of OPENING_GRID.rows) expect(row).toHaveLength(BOARD_COLS);
  });

  it("says its piece", () => {
    expect(text(OPENING_GRID)).toContain("SAY SOMETHING");
    expect(text(OPENING_GRID)).toContain("TO THE LIVING ROOM");
  });

  /**
   * The whole point of the fixed Latin string: it must survive the fold in every
   * locale, so it may not contain a character the object has no flap for. A line
   * that is too long would wrap and push the rest off the board silently.
   */
  it("fits the object it is printed on, character for character", () => {
    for (const line of OPENING_TEXT) {
      expect(line.length, line).toBeLessThanOrEqual(BOARD_COLS);
      for (const char of line) expect(isBoardChar(char), `${line}: ${char}`).toBe(true);
    }
  });

  it("spends exactly one pigment on the invitation", () => {
    const lit = new Set(
      OPENING_GRID.rows.flatMap((row) =>
        row.filter((cell) => cell.char !== " ").map((cell) => cell.color)
      )
    );
    expect([...lit].sort()).toEqual(["white", "yellow"]);
  });

  it("is a stable reference — the animator compares identity, not contents", () => {
    expect(typedBoard("").grid).toBe(OPENING_GRID);
    expect(typedBoard("   ").grid).toBe(OPENING_GRID);
  });

  it("starts from a blank board, so the first grid change is a flip", () => {
    expect(BLANK_GRID.rows.flat().every((cell) => cell.char === " ")).toBe(true);
    expect(BLANK_GRID).not.toBe(OPENING_GRID);
  });
});

describe("what a visitor types", () => {
  it("reaches the board uppercased, the way a flap can show it", () => {
    const typed = typedBoard("hello sofa");
    expect(typed.grid).not.toBeNull();
    expect(text(typed.grid!)).toContain("HELLO SOFA");
    expect(typed.note).toBe("none");
    expect(typed.used).toBe("hello sofa".length);
  });

  it("compiles to a legal grid, never a hand-built one", () => {
    const typed = typedBoard("dinner at 7");
    expect(Either.isRight(decodeBoardGrid(typed.grid!))).toBe(true);
  });

  it("folds accents rather than dropping the word", () => {
    const typed = typedBoard("café");
    expect(text(typed.grid!)).toContain("CAFE");
    expect(typed.note).toBe("none");
  });

  it("says so when a character has no flap", () => {
    const typed = typedBoard("hello \u{1F600}");
    expect(typed.note).toBe("dropped");
    expect(text(typed.grid!)).toContain("HELLO");
  });

  /**
   * The `zh` case, and the reason `grid` is nullable at all: a visitor typing
   * CJK folds away to nothing, and a blank rectangle where the product was is a
   * worse answer than holding the last thing the board could show.
   */
  it("holds the current board when nothing in the line has a flap", () => {
    const typed = typedBoard("客厅");
    expect(typed.grid).toBeNull();
    expect(typed.note).toBe("nothing");
    expect(typed.used).toBe(0);
  });

  it("admits it when the message is longer than the board", () => {
    const typed = typedBoard("WORD ".repeat(40));
    expect(typed.note).toBe("full");
    expect(typed.grid!.rows).toHaveLength(BOARD_ROWS);
    expect(typed.used).toBe(BOARD_CAPACITY);
  });

  it("counts against the board's real capacity", () => {
    expect(BOARD_CAPACITY).toBe(BOARD_ROWS * BOARD_COLS);
    expect(typedBoard("a".repeat(500)).used).toBe(BOARD_CAPACITY);
  });
});

/**
 * The typed state is the page's whole proof — "you drive the board before you
 * sign up" — and `design-critic` round 1 found it rendering as a *downgrade*
 * from the untouched state: one white line pinned to row 0 with five empty rows
 * beneath it, while the message that invited it was centred and lit.
 *
 * Nothing in the suite caught that, because nothing asserted where on the object
 * a line lands or what colour it arrives in. These do.
 */
describe("where a typed line lands on the object", () => {
  /** The indices of grid rows carrying at least one glyph. */
  const litRows = (grid: { rows: ReadonlyArray<ReadonlyArray<{ char: string }>> }) =>
    grid.rows.flatMap((row, i) => (row.some((c) => c.char !== " ") ? [i] : []));

  it("centres a one-line message instead of pinning it to the top", () => {
    const { grid } = typedBoard("DINNER AT EIGHT");
    expect(grid).not.toBeNull();
    // Six rows, one lit: the only vertically centred choices are 2 and 3.
    expect(litRows(grid!)).toEqual([2]);
  });

  it("keeps a wrapped message centred as one block", () => {
    // Longer than 24 columns, so the compiler wraps it across several rows.
    const { grid } = typedBoard(
      "THE BINS GO OUT ON TUESDAY NIGHT WITHOUT FAIL"
    );
    expect(grid).not.toBeNull();
    const lit = litRows(grid!);

    expect(lit.length).toBeGreaterThan(1);
    // Contiguous — the padding goes above the block, never through it.
    expect(lit).toEqual(
      Array.from({ length: lit.length }, (_, i) => lit[0]! + i)
    );
    // Balanced: blank rows above and below differ by at most one.
    const above = lit[0]!;
    const below = BOARD_ROWS - 1 - lit[lit.length - 1]!;
    expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
  });

  it("lights the visitor's own words rather than leaving them plain", () => {
    const { grid } = typedBoard("HELLO");
    const painted = new Set(
      grid!.rows.flatMap((row) =>
        row.filter((cell) => cell.char !== " ").map((cell) => cell.color)
      )
    );
    expect(painted).toEqual(new Set(["yellow"]));
  });

  it("never pushes text off the bottom to make room for the padding", () => {
    // Six rows' worth: the centring must collapse to zero lead, not truncate.
    const full = Array.from({ length: BOARD_ROWS }, () => "X".repeat(BOARD_COLS)).join(
      " "
    );
    const { grid, note } = typedBoard(full);
    expect(note).not.toBe("full");
    expect(litRows(grid!)).toHaveLength(BOARD_ROWS);
  });
});
