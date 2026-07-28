import { describe, expect, it } from "vitest";
import {
  addStrokeCell,
  parseCellRef,
  rowEdits,
  strokeEdits,
  type CellRef,
} from "../paint-gesture";
import { paintCells } from "../cell-paint";
import { compileToGrid } from "../compile";
import {
  BOARD_COLS,
  BOARD_ROWS,
  type BoardMessage,
} from "@/lib/schemas/board";

describe("addStrokeCell", () => {
  it("appends a new cell in the order it was touched", () => {
    let stroke: ReadonlyArray<CellRef> = [];
    stroke = addStrokeCell(stroke, { row: 0, col: 2 });
    stroke = addStrokeCell(stroke, { row: 0, col: 3 });
    stroke = addStrokeCell(stroke, { row: 1, col: 3 });

    expect(stroke).toEqual([
      { row: 0, col: 2 },
      { row: 0, col: 3 },
      { row: 1, col: 3 },
    ]);
  });

  it("drops a cell the stroke already crossed, however many times", () => {
    const first = addStrokeCell([], { row: 2, col: 5 });
    const again = addStrokeCell(first, { row: 2, col: 5 });
    const third = addStrokeCell(again, { row: 2, col: 5 });

    expect(again).toHaveLength(1);
    expect(third).toHaveLength(1);
  });

  it("returns the same array when nothing changed, so a caller can skip a render", () => {
    const stroke = addStrokeCell([], { row: 0, col: 0 });
    expect(addStrokeCell(stroke, { row: 0, col: 0 })).toBe(stroke);
  });

  it("treats a re-entered cell as already crossed, not as a new one", () => {
    // A finger wobbling back and forth over two columns.
    let stroke: ReadonlyArray<CellRef> = [];
    for (const col of [4, 5, 4, 5, 4, 6]) {
      stroke = addStrokeCell(stroke, { row: 0, col });
    }
    expect(stroke).toEqual([
      { row: 0, col: 4 },
      { row: 0, col: 5 },
      { row: 0, col: 6 },
    ]);
  });
});

describe("strokeEdits", () => {
  it("attaches one colour to every cell of the stroke", () => {
    expect(
      strokeEdits(
        [
          { row: 0, col: 1 },
          { row: 0, col: 2 },
        ],
        "blue"
      )
    ).toEqual([
      { row: 0, col: 1, color: "blue" },
      { row: 0, col: 2, color: "blue" },
    ]);
  });

  it("is empty for an empty stroke, which `paintCells` treats as a no-op", () => {
    const base: BoardMessage = {
      rows: [{ align: "left", segments: [{ text: "HI", color: "white" }] }],
    };
    expect(strokeEdits([], "red")).toEqual([]);
    expect(paintCells(base, strokeEdits([], "red"))).toBe(base);
  });
});

describe("rowEdits", () => {
  it("is exactly BOARD_COLS cells of one row, left to right", () => {
    const edits = rowEdits(3, "violet");
    expect(edits).toHaveLength(BOARD_COLS);
    expect(edits.every((edit) => edit.row === 3)).toBe(true);
    expect(edits.map((edit) => edit.col)).toEqual(
      Array.from({ length: BOARD_COLS }, (_, col) => col)
    );
    expect(edits.every((edit) => edit.color === "violet")).toBe(true);
  });

  it("fills a row of an empty board end to end", () => {
    const grid = compileToGrid(
      paintCells({ rows: [] }, rowEdits(0, "violet"))
    );
    expect(grid.rows[0]!.every((cell) => cell.color === "violet")).toBe(true);
    expect(grid.rows[0]!).toHaveLength(BOARD_COLS);
  });

  /**
   * The reference photo, in two taps. This is the whole reason the row handles
   * exist, so it is asserted end to end rather than on the edit list.
   */
  it("draws the top-and-bottom border in two gestures", () => {
    const withText: BoardMessage = {
      rows: [
        { align: "left", segments: [] },
        { align: "center", segments: [{ text: "HELLO", color: "white" }] },
      ],
    };
    const top = paintCells(withText, rowEdits(0, "violet"));
    const both = paintCells(top, rowEdits(BOARD_ROWS - 1, "violet"));
    const grid = compileToGrid(both);

    expect(grid.rows[0]!.every((cell) => cell.color === "violet")).toBe(true);
    expect(
      grid.rows[BOARD_ROWS - 1]!.every((cell) => cell.color === "violet")
    ).toBe(true);
    // The text between the bars survived both fills, still centred.
    expect(grid.rows[1]!.map((cell) => cell.char).join("").trim()).toBe("HELLO");
  });

  it("fills a row of multi-word text without leaving the gap unlit", () => {
    // The interaction with the sharpened colour rule: a filled row is a filled
    // row, spaces included, because each space run comes back as its own
    // all-space segment.
    const base: BoardMessage = {
      rows: [{ align: "left", segments: [{ text: "GOOD MORNING", color: "white" }] }],
    };
    const grid = compileToGrid(paintCells(base, rowEdits(0, "green")));

    expect(grid.rows[0]!.every((cell) => cell.color === "green")).toBe(true);
    expect(grid.rows[0]!.map((cell) => cell.char).join("").trimEnd()).toBe(
      "GOOD MORNING"
    );
  });

  it("is idempotent — filling the same row twice changes nothing", () => {
    const base: BoardMessage = {
      rows: [{ align: "left", segments: [{ text: "A B", color: "white" }] }],
    };
    const once = paintCells(base, rowEdits(0, "orange"));
    expect(paintCells(once, rowEdits(0, "orange"))).toEqual(once);
  });
});

describe("parseCellRef", () => {
  it("reads an in-range integer pair", () => {
    expect(parseCellRef("2", "17")).toEqual({ row: 2, col: 17 });
    expect(parseCellRef("0", "0")).toEqual({ row: 0, col: 0 });
    expect(parseCellRef(String(BOARD_ROWS - 1), String(BOARD_COLS - 1))).toEqual({
      row: BOARD_ROWS - 1,
      col: BOARD_COLS - 1,
    });
  });

  it("rejects anything that is not an in-range integer pair", () => {
    expect(parseCellRef(undefined, "0")).toBeNull();
    expect(parseCellRef("0", undefined)).toBeNull();
    // `Number("")` is 0, which would silently become row 0.
    expect(parseCellRef("", "0")).toBeNull();
    expect(parseCellRef("   ", "0")).toBeNull();
    expect(parseCellRef("NaN", "0")).toBeNull();
    expect(parseCellRef("1.5", "0")).toBeNull();
    expect(parseCellRef("-1", "0")).toBeNull();
    expect(parseCellRef(String(BOARD_ROWS), "0")).toBeNull();
    expect(parseCellRef("0", String(BOARD_COLS))).toBeNull();
  });
});
