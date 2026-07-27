import { describe, expect, it } from "vitest";
import { compileToGrid } from "../compile";
import { paintCell } from "../cell-paint";
import {
  emptyLayout,
  layoutToMessage,
  messageToLayout,
  type LayoutValues,
  type RowValues,
} from "../segment-layout";
import {
  BLANK_COLOR,
  BOARD_COLS,
  BOARD_ROWS,
  type BoardColor,
  type BoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Editor values with the named rows filled in and the rest left empty. */
const layout = (rows: ReadonlyArray<Partial<RowValues>>): LayoutValues => ({
  rows: Array.from({ length: BOARD_ROWS }, (_, index) => ({
    align: "left" as const,
    segments: [{ text: "", color: "white" as BoardColor }],
    ...(rows[index] ?? {}),
  })),
});

const row = (
  align: RowValues["align"],
  segments: ReadonlyArray<readonly [string, BoardColor]>
): RowValues => ({
  align,
  segments: segments.map(([text, color]) => ({ text, color })),
});

const line = (grid: BoardGrid, index: number): string =>
  grid.rows[index]!.map((cell) => cell.char).join("");

const lit = (grid: BoardGrid, index: number): ReadonlyArray<string> =>
  grid.rows[index]!.flatMap((cell, col) =>
    cell.char === " " && cell.color === BLANK_COLOR
      ? []
      : [`${col}:${cell.char === " " ? "_" : cell.char}:${cell.color}`]
  );

/* -------------------------------------------------------------------------- */
/* The one-segment case must not change                                       */
/* -------------------------------------------------------------------------- */

describe("layoutToMessage — the single-segment row", () => {
  it("emits one segment carrying that row's colour and alignment", () => {
    const message = layoutToMessage(
      layout([row("center", [["HELLO", "red"]])])
    );

    expect(message.rows).toHaveLength(BOARD_ROWS);
    expect(message.rows[0]).toEqual({
      align: "center",
      segments: [{ text: "HELLO", color: "red" }],
    });
  });

  it("emits an empty segment list for an empty row, not a segment holding ''", () => {
    expect(layoutToMessage(layout([])).rows[0]!.segments).toEqual([]);
  });

  it("drops trailing whitespace so padding cannot light up", () => {
    const message = layoutToMessage(layout([row("left", [["HI      ", "white"]])]));
    expect(message.rows[0]!.segments).toEqual([{ text: "HI", color: "white" }]);
  });

  it("keeps leading whitespace, which is indentation in white and a tile in colour", () => {
    const message = layoutToMessage(layout([row("left", [["  HI", "white"]])]));
    expect(message.rows[0]!.segments).toEqual([{ text: "  HI", color: "white" }]);
  });

  it("drops a segment the user never typed into", () => {
    const message = layoutToMessage(
      layout([row("left", [["HI", "white"], ["", "red"]])])
    );
    expect(message.rows[0]!.segments).toEqual([{ text: "HI", color: "white" }]);
  });
});

/* -------------------------------------------------------------------------- */
/* Multi-segment rows                                                         */
/* -------------------------------------------------------------------------- */

describe("layoutToMessage — several segments on one row", () => {
  it("keeps each segment's own colour on one board row", () => {
    const grid = compileToGrid(
      layoutToMessage(
        layout([row("left", [["OSLO ", "white"], ["12°", "blue"]])])
      )
    );

    expect(line(grid, 0)).toBe("OSLO 12°".padEnd(BOARD_COLS, " "));
    expect(lit(grid, 0)).toEqual([
      "0:O:white",
      "1:S:white",
      "2:L:white",
      "3:O:white",
      "5:1:blue",
      "6:2:blue",
      "7:°:blue",
    ]);
  });

  it("keeps an interior segment's trailing spaces — that gap is the layout", () => {
    const message = layoutToMessage(
      layout([row("left", [["OSLO    ", "white"], ["12°", "blue"]])])
    );

    expect(message.rows[0]!.segments).toEqual([
      { text: "OSLO    ", color: "white" },
      { text: "12°", color: "blue" },
    ]);
    expect(lit(compileToGrid(message), 0)).toContain("8:1:blue");
  });

  it("keeps a coloured all-space segment, which is how a solid bar is drawn", () => {
    const message = layoutToMessage(
      layout([row("left", [["    ", "red"], ["HI", "white"]])])
    );
    const grid = compileToGrid(message);

    expect(lit(grid, 0)).toEqual([
      "0:_:red",
      "1:_:red",
      "2:_:red",
      "3:_:red",
      "4:H:white",
      "5:I:white",
    ]);
  });

  it("keeps a coloured all-space segment even as the last segment of the row", () => {
    // The paint round-trip depends on this: a painted tile at the right-hand end
    // of a row arrives here as a coloured space and must survive.
    const message = layoutToMessage(
      layout([row("left", [["HI", "white"], ["  ", "red"]])])
    );

    expect(lit(compileToGrid(message), 0)).toEqual([
      "0:H:white",
      "1:I:white",
      "2:_:red",
      "3:_:red",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* spread — left and right on one row                                         */
/* -------------------------------------------------------------------------- */

describe("layoutToMessage — spread", () => {
  it("hands the alignment to the compiler instead of computing gaps itself", () => {
    const message = layoutToMessage(
      layout([row("spread", [["OSLO", "white"], ["12°", "blue"]])])
    );

    // The editor no longer resolves `spread`: it reaches the schema verbatim, and
    // the segments are exactly the two the user typed — no synthesised gap.
    expect(message.rows[0]).toEqual({
      align: "spread",
      segments: [
        { text: "OSLO", color: "white" },
        { text: "12°", color: "blue" },
      ],
    });

    const grid = compileToGrid(message);
    expect(lit(grid, 0)).toEqual([
      "0:O:white",
      "1:S:white",
      "2:L:white",
      "3:O:white",
      "21:1:blue",
      "22:2:blue",
      "23:°:blue",
    ]);
  });

  it("distributes the free columns between three segments", () => {
    const grid = compileToGrid(
      layoutToMessage(
        layout([
          row("spread", [
            ["BA", "white"],
            ["OK", "green"],
            ["12", "red"],
          ]),
        ])
      )
    );

    expect(lit(grid, 0)).toEqual([
      "0:B:white",
      "1:A:white",
      // Two 9-column gaps: 2 + 9 + 2 + 9 + 2 = 24.
      "11:O:green",
      "12:K:green",
      "22:1:red",
      "23:2:red",
    ]);
  });

  it("measures widths as the board will show them, not as typed", () => {
    // "ü" folds to "U" and the emoji is dropped entirely, so the gap has to be
    // computed after normalisation or the row would not reach the right edge.
    const grid = compileToGrid(
      layoutToMessage(
        layout([row("spread", [["zürich 🌧", "white"], ["4", "blue"]])])
      )
    );

    expect(line(grid, 0)).toBe(`ZURICH ${" ".repeat(16)}4`);
    expect(lit(grid, 0)).toContain("23:4:blue");
  });

  it("clips rather than wraps when the row cannot fit", () => {
    const message = layoutToMessage(
      layout([
        row("spread", [
          ["A".repeat(20), "white"],
          ["B".repeat(20), "blue"],
        ]),
      ])
    );

    // The user's text is never rewritten; the compiler collapses the gap to one
    // column and clips, and a spread row stays one row.
    expect(message.rows[0]!.segments).toHaveLength(2);
    expect(line(compileToGrid(message), 0)).toBe(
      `${"A".repeat(20)} BBB`.slice(0, BOARD_COLS)
    );
    expect(line(compileToGrid(message), 1)).toBe(" ".repeat(BOARD_COLS));
  });

  it("renders identically to left when there is nothing to spread", () => {
    const spread = layoutToMessage(layout([row("spread", [["HI", "white"]])]));
    const left = layoutToMessage(layout([row("left", [["HI", "white"]])]));

    expect(spread.rows[0]!.align).toBe("spread");
    expect(compileToGrid(spread)).toEqual(compileToGrid(left));
  });

  it("strips the row's trailing padding before measuring the gap", () => {
    const message = layoutToMessage(
      layout([row("spread", [["OSLO", "white"], ["12°   ", "blue"]])])
    );
    // Colour applies to glyphs, so the blue segment's trailing spaces are no
    // longer lit tiles — but they are still *cells*, and cells would push the
    // value three columns off the right edge. So the last segment's padding is
    // stripped whatever colour it is, and the row ends flush right on the value.
    expect(message.rows[0]!.segments).toEqual([
      { text: "OSLO", color: "white" },
      { text: "12°", color: "blue" },
    ]);
    expect(lit(compileToGrid(message), 0)).toContain("23:°:blue");
  });

  it("keeps an all-space pigment segment as the row's last, padding or not", () => {
    // The exception the paint round-trip needs: a bar is not padding.
    const message = layoutToMessage(
      layout([row("left", [["HI", "white"], ["   ", "violet"]])])
    );
    expect(message.rows[0]!.segments).toEqual([
      { text: "HI", color: "white" },
      { text: "   ", color: "violet" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* BoardMessage → editor rows                                                 */
/* -------------------------------------------------------------------------- */

describe("messageToLayout", () => {
  it("pads to a full board and gives every row something to type into", () => {
    const values = messageToLayout({ rows: [{ align: "right", segments: [] }] });

    expect(values.rows).toHaveLength(BOARD_ROWS);
    expect(values.rows[0]).toEqual({
      align: "right",
      segments: [{ text: "", color: "white" }],
    });
    expect(values.rows[5]).toEqual({
      align: "left",
      segments: [{ text: "", color: "white" }],
    });
  });

  it("keeps every segment, so a multi-coloured row stays editable", () => {
    const values = messageToLayout({
      rows: [
        {
          align: "left",
          segments: [
            { text: "OSLO ", color: "white" },
            { text: "12°", color: "blue" },
          ],
        },
      ],
    });

    expect(values.rows[0]!.segments).toEqual([
      { text: "OSLO ", color: "white" },
      { text: "12°", color: "blue" },
    ]);
  });

  it("hands back mutable arrays the form can own", () => {
    const values = messageToLayout({ rows: [] });
    values.rows[0]!.segments.push({ text: "X", color: "red" });
    expect(values.rows[0]!.segments).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The round trip the paint mode rides on                                     */
/* -------------------------------------------------------------------------- */

describe("layoutToMessage ∘ messageToLayout", () => {
  /** A board that has been through the form and back. */
  const reflow = (message: BoardMessage): BoardGrid =>
    compileToGrid(layoutToMessage(messageToLayout(message)));

  /** The weather row, as `spread` produces it. */
  const weather = (): BoardMessage =>
    layoutToMessage(
      layout([
        row("left", [
          ["OSLO", "white"],
          [" ".repeat(17), "white"],
          ["12°", "blue"],
        ]),
      ])
    );

  it("is grid-stable for an empty board", () => {
    const empty = layoutToMessage(emptyLayout());
    expect(reflow(empty)).toEqual(compileToGrid(empty));
  });

  it("is grid-stable for the weather row itself", () => {
    expect(reflow(weather())).toEqual(compileToGrid(weather()));
  });

  it("keeps a spread row spread, so its gaps re-flow instead of freezing", () => {
    const spread = layoutToMessage(
      layout([row("spread", [["RAIN", "white"], ["30%", "orange"]])])
    );
    const back = messageToLayout(spread);

    expect(back.rows[0]!.align).toBe("spread");
    expect(layoutToMessage(back).rows[0]).toEqual(spread.rows[0]);
    expect(reflow(spread)).toEqual(compileToGrid(spread));
  });

  /**
   * The load-bearing property of paint mode: a paint writes its result back into
   * the editor's rows, so a painted board read back out of the form must compile
   * to the same grid — otherwise every tap would nudge the layout.
   */
  it.each([
    ["a tile painted on top of text", 1, "red" as BoardColor],
    ["a space lit out in the gap", 10, "blue" as BoardColor],
    ["a tile lit at the very last column", 23, "green" as BoardColor],
    ["a character unlit", 2, "black" as BoardColor],
  ])("survives %s", (_name, col, color) => {
    const painted = paintCell(weather(), { row: 0, col, color });
    expect(reflow(painted)).toEqual(compileToGrid(painted));
  });

  it("survives a stroke drawn one tap at a time, through the form each time", () => {
    let painted = layoutToMessage(layout([row("left", [["OSLO", "white"]])]));
    for (const col of [21, 22, 23]) {
      painted = paintCell(painted, { row: 0, col, color: "red" });
      // Between every tap the board goes back through the form, exactly as the
      // editor does it.
      painted = layoutToMessage(messageToLayout(painted));
    }

    expect(lit(compileToGrid(painted), 0)).toEqual([
      "0:O:white",
      "1:S:white",
      "2:L:white",
      "3:O:white",
      "21:_:red",
      "22:_:red",
      "23:_:red",
    ]);
  });
});
