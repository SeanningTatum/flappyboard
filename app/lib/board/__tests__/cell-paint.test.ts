import { describe, expect, it } from "vitest";
import { compileToGrid } from "../compile";
import { paintCell, paintCells, type CellEdit } from "../cell-paint";
import {
  BLANK_COLOR,
  BOARD_COLS,
  BOARD_ROWS,
  type BoardAlign,
  type BoardCell,
  type BoardColor,
  type BoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const BLANK: BoardCell = { char: " ", color: BLANK_COLOR };

/** A message from a terse literal: `[["OSLO", "white"]]` is one white segment. */
const message = (
  rows: ReadonlyArray<{
    readonly align?: BoardAlign;
    readonly segments: ReadonlyArray<readonly [string, BoardColor]>;
  }>
): BoardMessage => ({
  rows: rows.map((row) => ({
    align: row.align ?? "left",
    segments: row.segments.map(([text, color]) => ({ text, color })),
  })),
});

const line = (grid: BoardGrid, row: number): string =>
  grid.rows[row]!.map((cell) => cell.char).join("");

/**
 * Every lit cell of a row as `col:char:color`. Asserting on this rather than on
 * 24 cells is what makes "and nothing else lit up" a readable expectation.
 */
const lit = (grid: BoardGrid, row: number): ReadonlyArray<string> =>
  grid.rows[row]!.flatMap((cell, col) =>
    cell.char === " " && cell.color === BLANK_COLOR
      ? []
      : [`${col}:${cell.char === " " ? "_" : cell.char}:${cell.color}`]
  );

/** The expected grid, built by hand — no implementation logic reused. */
const withCell = (
  grid: BoardGrid,
  row: number,
  col: number,
  cell: BoardCell
): BoardGrid => ({
  rows: grid.rows.map((cells, rowIndex) =>
    rowIndex !== row
      ? cells
      : cells.map((old, colIndex) => (colIndex !== col ? old : cell))
  ),
});

const paint = (
  base: BoardMessage,
  row: number,
  col: number,
  color: BoardColor
): BoardMessage => paintCell(base, { row, col, color });

/* -------------------------------------------------------------------------- */
/* Recolouring one cell                                                       */
/* -------------------------------------------------------------------------- */

describe("paintCell", () => {
  it("recolours exactly the cell asked for and nothing else", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const painted = paint(base, 0, 1, "red");
    const grid = compileToGrid(painted);

    expect(line(grid, 0)).toBe("OSLO".padEnd(BOARD_COLS, " "));
    expect(lit(grid, 0)).toEqual([
      "0:O:white",
      "1:S:red",
      "2:L:white",
      "3:O:white",
    ]);
    // The paint is expressed as segments, not as a grid smuggled into the schema.
    expect(painted.rows[0]!.segments).toEqual([
      { text: "O", color: "white" },
      { text: "S", color: "red" },
      { text: "LO", color: "white" },
    ]);
  });

  it("reproduces the painted grid exactly when compiled again", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const before = compileToGrid(base);

    expect(compileToGrid(paint(base, 0, 1, "red"))).toEqual(
      withCell(before, 0, 1, { char: "S", color: "red" })
    );
  });

  it("is idempotent — painting the same cell twice changes nothing", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const once = paint(base, 0, 1, "red");
    const twice = paint(once, 0, 1, "red");

    expect(twice).toEqual(once);
    expect(compileToGrid(twice)).toEqual(compileToGrid(once));
  });

  it("leaves every other row untouched", () => {
    const base = message([
      { segments: [["OSLO", "white"]] },
      { align: "center", segments: [["RAIN", "blue"]] },
      { align: "right", segments: [["12", "red"]] },
    ]);
    const painted = paint(base, 0, 0, "green");

    expect(painted.rows[1]).toEqual(base.rows[1]);
    expect(painted.rows[2]).toEqual(base.rows[2]);
  });

  /* ---------------------------------------------------------------------- */
  /* Spaces and the unlit tile                                              */
  /* ---------------------------------------------------------------------- */

  it("lights a space as a colour tile", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const before = compileToGrid(base);
    const painted = paint(base, 0, 20, "blue");
    const grid = compileToGrid(painted);

    expect(lit(grid, 0)).toEqual([
      "0:O:white",
      "1:S:white",
      "2:L:white",
      "3:O:white",
      "20:_:blue",
    ]);
    expect(grid).toEqual(withCell(before, 0, 20, { char: " ", color: "blue" }));
  });

  it("treats painting white onto a space as leaving it unlit", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const before = compileToGrid(base);
    const grid = compileToGrid(paint(base, 0, 20, "white"));

    // A white space *is* an unlit tile — `compileMessage` never emits one, so
    // neither does a paint.
    expect(grid).toEqual(before);
  });

  it("unlights a lit tile when painted black, keeping its neighbours", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const before = compileToGrid(base);
    const grid = compileToGrid(paint(base, 0, 2, "black"));

    expect(lit(grid, 0)).toEqual(["0:O:white", "1:S:white", "3:O:white"]);
    expect(grid).toEqual(withCell(before, 0, 2, BLANK));
  });

  it("unlights the only lit cell in a row without disturbing the row count", () => {
    const base = message([{ segments: [["A", "red"]] }]);
    const painted = paint(base, 0, 0, "black");
    const grid = compileToGrid(painted);

    expect(lit(grid, 0)).toEqual([]);
    expect(grid.rows).toHaveLength(BOARD_ROWS);
  });

  /* ---------------------------------------------------------------------- */
  /* Alignment — where the padding is                                       */
  /* ---------------------------------------------------------------------- */

  it("keeps a centred row centred when its leftmost lit cell does not move", () => {
    const base = message([{ align: "center", segments: [["HI", "white"]] }]);
    const before = compileToGrid(base);
    expect(lit(before, 0)).toEqual(["11:H:white", "12:I:white"]);

    const painted = paint(base, 0, 11, "red");
    expect(painted.rows[0]!.align).toBe("center");
    expect(compileToGrid(painted)).toEqual(
      withCell(before, 0, 11, { char: "H", color: "red" })
    );
  });

  it("keeps a right-aligned row right-aligned", () => {
    const base = message([{ align: "right", segments: [["12", "white"]] }]);
    const before = compileToGrid(base);
    expect(lit(before, 0)).toEqual(["22:1:white", "23:2:white"]);

    const painted = paint(base, 0, 23, "red");
    expect(painted.rows[0]!.align).toBe("right");
    expect(compileToGrid(painted)).toEqual(
      withCell(before, 0, 23, { char: "2", color: "red" })
    );
  });

  /**
   * The documented limit. Unlit tiles *before* a row's first lit tile exist only
   * as alignment padding (`compile.ts` drops a leading separator run), and
   * alignment offers three offsets. Painting into a centred row's padding asks for
   * a fourth, so the row keeps its centring and is re-centred around its new
   * content — one column right of the tap here — rather than throwing.
   */
  it("keeps the row's alignment when the new left offset is not expressible", () => {
    const base = message([{ align: "center", segments: [["HI", "white"]] }]);
    const painted = paint(base, 0, 9, "red");
    const grid = compileToGrid(painted);

    expect(painted.rows[0]!.align).toBe("center");
    expect(lit(grid, 0)).toEqual(["10:_:red", "12:H:white", "13:I:white"]);
  });

  /* ---------------------------------------------------------------------- */
  /* Lighting a tile in an empty row                                        */
  /* ---------------------------------------------------------------------- */

  it("anchors a lone tile at the left edge of an empty row", () => {
    // Column 8 is not an alignment offset for a one-cell row, and unlit tiles
    // cannot precede lit ones, so the tile lands flush left.
    const base = message([{ segments: [] }]);
    const grid = compileToGrid(paint(base, 0, 8, "red"));

    expect(lit(grid, 0)).toEqual(["0:_:red"]);
  });

  it.each([
    ["the left edge", 0, "left" as const],
    ["the centre", 11, "center" as const],
    ["the right edge", 23, "right" as const],
  ])("lights a lone tile exactly at %s", (_name, col, align) => {
    const base = message([{ segments: [] }]);
    const painted = paint(base, 0, col, "red");

    expect(painted.rows[0]!.align).toBe(align);
    expect(lit(compileToGrid(painted), 0)).toEqual([`${col}:_:red`]);
  });

  it("holds still once a row has an anchor, so a run of taps accumulates", () => {
    let painted = message([{ segments: [] }]);
    for (const col of [0, 9, 10, 11]) {
      painted = paint(painted, 0, col, "red");
    }

    expect(lit(compileToGrid(painted), 0)).toEqual([
      "0:_:red",
      "9:_:red",
      "10:_:red",
      "11:_:red",
    ]);
  });

  it("places a whole stroke exactly where taps one at a time could not", () => {
    // Eight cells from column 8 leave 16 free, and centring puts 8 of them on the
    // left — so the stroke is expressible even though its first cell alone is not.
    const base = message([{ segments: [] }]);
    const edits: ReadonlyArray<CellEdit> = [8, 9, 10, 11, 12, 13, 14, 15].map(
      (col) => ({ row: 0, col, color: "red" as const })
    );
    const grid = compileToGrid(paintCells(base, edits));

    expect(lit(grid, 0)).toEqual(
      [8, 9, 10, 11, 12, 13, 14, 15].map((col) => `${col}:_:red`)
    );
  });

  it("keeps a left-aligned row flush left when its first character is unlit", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const painted = paint(base, 0, 0, "black");
    const grid = compileToGrid(painted);

    // "SLO" cannot start at column 1 — a left-aligned row has no leading pad —
    // so it moves flush left. The preview shows this the moment it happens.
    expect(painted.rows[0]!.align).toBe("left");
    expect(lit(grid, 0)).toEqual(["0:S:white", "1:L:white", "2:O:white"]);
  });

  /* ---------------------------------------------------------------------- */
  /* Out of range                                                           */
  /* ---------------------------------------------------------------------- */

  it("returns the message untouched for an out-of-range cell", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);

    expect(paint(base, BOARD_ROWS, 0, "red")).toBe(base);
    expect(paint(base, 0, BOARD_COLS, "red")).toBe(base);
    expect(paint(base, -1, 0, "red")).toBe(base);
    expect(paint(base, 0, -1, "red")).toBe(base);
    expect(paint(base, 0.5, 0, "red")).toBe(base);
    expect(paint(base, Number.NaN, 0, "red")).toBe(base);
  });
});

/* -------------------------------------------------------------------------- */
/* Strokes                                                                    */
/* -------------------------------------------------------------------------- */

describe("paintCells", () => {
  it("draws a run of tiles in one pass", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const edits: ReadonlyArray<CellEdit> = [20, 21, 22, 23].map((col) => ({
      row: 0,
      col,
      color: "red" as const,
    }));
    const grid = compileToGrid(paintCells(base, edits));

    expect(lit(grid, 0)).toEqual([
      "0:O:white",
      "1:S:white",
      "2:L:white",
      "3:O:white",
      "20:_:red",
      "21:_:red",
      "22:_:red",
      "23:_:red",
    ]);
  });

  it("paints across rows in one stroke", () => {
    const base = message([
      { segments: [["A", "white"]] },
      { segments: [["B", "white"]] },
    ]);
    const grid = compileToGrid(
      paintCells(base, [
        { row: 0, col: 0, color: "green" },
        { row: 1, col: 0, color: "violet" },
      ])
    );

    expect(lit(grid, 0)).toEqual(["0:A:green"]);
    expect(lit(grid, 1)).toEqual(["0:B:violet"]);
  });

  it("drops out-of-range members of a stroke and applies the rest", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const grid = compileToGrid(
      paintCells(base, [
        { row: 0, col: 0, color: "red" },
        { row: 99, col: 99, color: "green" },
      ])
    );

    expect(lit(grid, 0)).toEqual([
      "0:O:red",
      "1:S:white",
      "2:L:white",
      "3:O:white",
    ]);
  });

  /* ---------------------------------------------------------------------- */
  /* Colour applies to glyphs — the round trip after the rule change         */
  /* ---------------------------------------------------------------------- */

  it("paints a whole row of multi-word text and keeps every tile lit", () => {
    // The row gesture, and the case the sharpened rule could have broken: the
    // recovered message must not carry `HI THERE` as one segment, or the space
    // between the words would go out on the next compile.
    const base = message([{ segments: [["HI THERE", "white"]] }]);
    const edits: ReadonlyArray<CellEdit> = Array.from(
      { length: BOARD_COLS },
      (_, col) => ({ row: 0, col, color: "red" as const })
    );
    const painted = paintCells(base, edits);
    const grid = compileToGrid(painted);

    expect(grid.rows[0]!.every((cell) => cell.color === "red")).toBe(true);
    expect(line(grid, 0)).toBe("HI THERE".padEnd(BOARD_COLS, " "));
    expect(painted.rows[0]!.segments).toEqual([
      { text: "HI", color: "red" },
      { text: " ", color: "red" },
      { text: "THERE", color: "red" },
      { text: " ".repeat(BOARD_COLS - 8), color: "red" },
    ]);
    // And it is a fixed point: painting the same row again changes nothing.
    expect(paintCells(painted, edits)).toEqual(painted);
  });

  it("paints one cell of a coloured multi-word row without relighting its gap", () => {
    // `HAPPY FRIDAY!` in green has an unlit gap. Painting an unrelated cell must
    // not resurrect it.
    const base = message([{ segments: [["HAPPY FRIDAY!", "green"]] }]);
    const before = compileToGrid(base);
    expect(before.rows[0]![5]).toEqual(BLANK);

    const grid = compileToGrid(paint(base, 0, 0, "red"));
    expect(grid).toEqual(withCell(before, 0, 0, { char: "H", color: "red" }));
    expect(grid.rows[0]![5]).toEqual(BLANK);
  });

  it("returns the message untouched for an empty stroke", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    expect(paintCells(base, [])).toBe(base);
  });

  it("stays stable under repeated strokes", () => {
    const base = message([{ segments: [["OSLO", "white"]] }]);
    const once = paintCells(base, [
      { row: 0, col: 20, color: "blue" },
      { row: 0, col: 21, color: "blue" },
    ]);
    const twice = paintCells(once, [
      { row: 0, col: 20, color: "blue" },
      { row: 0, col: 21, color: "blue" },
    ]);

    expect(twice).toEqual(once);
  });
});
