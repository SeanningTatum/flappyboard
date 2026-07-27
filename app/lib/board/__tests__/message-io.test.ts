import { describe, expect, it } from "vitest";
import { compileMessage } from "../compile";
import {
  gridToMessage,
  toBoardMessage,
  type EditorValues,
} from "../message-io";
import {
  BLANK_COLOR,
  BOARD_COLS,
  BOARD_ROWS,
  type BoardCell,
  type BoardColor,
  type BoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const editorRows = (
  rows: ReadonlyArray<Partial<EditorValues["rows"][number]>>
): EditorValues => ({
  rows: Array.from({ length: BOARD_ROWS }, (_, index) => ({
    text: "",
    color: "white" as BoardColor,
    align: "left" as const,
    ...(rows[index] ?? {}),
  })),
});

const rowText = (row: ReadonlyArray<BoardCell>): string =>
  row.map((cell) => cell.char).join("");

/** Colour of every lit cell in a row, in order, with runs collapsed. */
const rowColorRuns = (
  row: ReadonlyArray<BoardCell>
): ReadonlyArray<readonly [BoardColor, number]> => {
  const runs: Array<[BoardColor, number]> = [];
  for (const cell of row) {
    if (cell.char === " " && cell.color === BLANK_COLOR) continue;
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === cell.color) last[1] += 1;
    else runs.push([cell.color, 1]);
  }
  return runs;
};

const gridText = (grid: BoardGrid): ReadonlyArray<string> =>
  grid.rows.map(rowText);

/* -------------------------------------------------------------------------- */
/* toBoardMessage                                                             */
/* -------------------------------------------------------------------------- */

describe("toBoardMessage", () => {
  it("emits one segment per non-empty row, carrying that row's colour", () => {
    const message = toBoardMessage(
      editorRows([{ text: "HELLO", color: "red", align: "center" }])
    );
    expect(message.rows).toHaveLength(BOARD_ROWS);
    expect(message.rows[0]).toEqual({
      align: "center",
      segments: [{ text: "HELLO", color: "red" }],
    });
  });

  it("emits an empty segment list for an empty row, not a segment holding ''", () => {
    const message = toBoardMessage(editorRows([]));
    expect(message.rows[0]!.segments).toEqual([]);
  });

  it("drops trailing whitespace so a coloured row cannot light up padding", () => {
    const message = toBoardMessage(
      editorRows([{ text: "HI      ", color: "red" }])
    );
    expect(message.rows[0]!.segments).toEqual([{ text: "HI", color: "red" }]);

    // The point of the trim: a red trailing space would compile to a lit red tile.
    const { grid } = compileMessage(message);
    expect(rowColorRuns(grid.rows[0]!)).toEqual([["red", 2]]);
  });

  it("keeps leading whitespace — that is indentation, not padding", () => {
    const message = toBoardMessage(editorRows([{ text: "  HI" }]));
    expect(message.rows[0]!.segments).toEqual([
      { text: "  HI", color: "white" },
    ]);
  });

  it("a row that is only whitespace collapses to an empty row", () => {
    const message = toBoardMessage(editorRows([{ text: "   " }]));
    expect(message.rows[0]!.segments).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* gridToMessage                                                              */
/* -------------------------------------------------------------------------- */

describe("gridToMessage", () => {
  it("returns exactly BOARD_ROWS rows", () => {
    const { grid } = compileMessage(toBoardMessage(editorRows([{ text: "HI" }])));
    expect(gridToMessage(grid).rows).toHaveLength(BOARD_ROWS);
  });

  it("collapses a run of same-coloured cells into one segment", () => {
    const { grid } = compileMessage(
      toBoardMessage(editorRows([{ text: "ABC", color: "green" }]))
    );
    expect(gridToMessage(grid).rows[0]!.segments).toEqual([
      { text: "ABC", color: "green" },
    ]);
  });

  it("recovers a multi-colour row as one segment per colour run", () => {
    const message: BoardMessage = {
      rows: [
        {
          align: "left",
          segments: [
            { text: "AB", color: "red" },
            { text: "CD", color: "blue" },
            { text: "EF", color: "red" },
          ],
        },
      ],
    };
    const { grid } = compileMessage(message);
    expect(gridToMessage(grid).rows[0]!.segments).toEqual([
      { text: "AB", color: "red" },
      { text: "CD", color: "blue" },
      { text: "EF", color: "red" },
    ]);
  });

  it("turns an interior unlit cell into a white space, not a lit white tile", () => {
    // A space in `white` compiles to the *unlit* blank cell — that is what makes
    // it a separator. Recovering it must not turn it into a lit white tile.
    const { grid } = compileMessage({
      rows: [
        {
          align: "left",
          segments: [
            { text: "A", color: "red" },
            { text: " ", color: "white" },
            { text: "B", color: "blue" },
          ],
        },
      ],
    });
    expect(grid.rows[0]![1]).toEqual({ char: " ", color: BLANK_COLOR });

    const segments = gridToMessage(grid).rows[0]!.segments;
    expect(segments).toEqual([
      { text: "A", color: "red" },
      { text: " ", color: "white" },
      { text: "B", color: "blue" },
    ]);
    // Recompiled, the middle cell is unlit again rather than a white tile.
    const again = compileMessage({ rows: [{ align: "left", segments }] }).grid;
    expect(again.rows[0]![1]).toEqual({ char: " ", color: BLANK_COLOR });
    expect(rowColorRuns(again.rows[0]!)).toEqual([
      ["red", 1],
      ["blue", 1],
    ]);
  });

  it("an interior space in a coloured word segment is a separator, not a tile", () => {
    // The other half of the sharpened rule: colour applies to *glyphs*, so "A B"
    // typed in red is a red A, an unlit gap and a red B — not a three-cell red
    // run. This is the `HAPPY#FRIDAY!` defect, seen from the recovery side.
    const { grid } = compileMessage(
      toBoardMessage(editorRows([{ text: "A B", color: "red" }]))
    );
    expect(grid.rows[0]![1]).toEqual({ char: " ", color: BLANK_COLOR });

    // `rowColorRuns` skips unlit cells, so two red runs either side of a blank
    // read as one run of two — which is the point: only two tiles are lit.
    expect(rowColorRuns(grid.rows[0]!)).toEqual([["red", 2]]);
    expect(gridToMessage(grid).rows[0]!.segments).toEqual([
      { text: "A", color: "red" },
      { text: " ", color: "white" },
      { text: "B", color: "red" },
    ]);
  });

  it("splits a pigment run at its spaces so a painted word round-trips", () => {
    // A whole row painted red arrives as one red run mixing glyphs and spaces.
    // Emitted as a single segment it would no longer be all-spaces, so its
    // interior spaces would go out on the next compile. Splitting at the space
    // boundaries keeps every tile lit.
    const grid: BoardGrid = {
      rows: Array.from({ length: BOARD_ROWS }, (_, index) =>
        index !== 0
          ? Array.from({ length: BOARD_COLS }, () => ({
              char: " ",
              color: BLANK_COLOR as BoardColor,
            }))
          : Array.from({ length: BOARD_COLS }, (_cell, col) => ({
              char: "HI THERE"[col] ?? " ",
              color: "red" as BoardColor,
            }))
      ),
    };

    const recovered = gridToMessage(grid).rows[0]!;
    expect(recovered.segments).toEqual([
      { text: "HI", color: "red" },
      { text: " ", color: "red" },
      { text: "THERE", color: "red" },
      { text: " ".repeat(BOARD_COLS - 8), color: "red" },
    ]);
    expect(compileMessage({ rows: [recovered] }).grid.rows[0]).toEqual(
      grid.rows[0]
    );
  });

  it("does not split a white run at its spaces — a spread row's gap is one segment", () => {
    const { grid } = compileMessage({
      rows: [
        {
          align: "spread",
          segments: [
            { text: "RAIN", color: "white" },
            { text: "30%", color: "orange" },
          ],
        },
      ],
    });
    expect(gridToMessage(grid).rows[0]!.segments).toEqual([
      { text: `RAIN${" ".repeat(17)}`, color: "white" },
      { text: "30%", color: "orange" },
    ]);
  });

  it("reads alignment back out of the padding widths", () => {
    const align = (text: string, alignment: "left" | "center" | "right") =>
      gridToMessage(
        compileMessage(toBoardMessage(editorRows([{ text, align: alignment }])))
          .grid
      ).rows[0]!.align;

    expect(align("HI", "left")).toBe("left");
    expect(align("HI", "center")).toBe("center");
    expect(align("HI", "right")).toBe("right");
  });

  it("a blank row recovers as an empty row (its align is arbitrary but harmless)", () => {
    const { grid } = compileMessage(toBoardMessage(editorRows([])));
    const row = gridToMessage(grid).rows[0]!;
    expect(row.segments).toEqual([]);
    // An all-blank row is 24 leading pad and 0 trailing, which reads as `right`.
    // Recorded rather than "fixed" because align is a no-op with no content:
    // `padLine([], anything)` is a blank row, which the round-trip test relies on.
    expect(row.align).toBe("right");
    expect(compileMessage({ rows: [row] }).grid.rows[0]).toEqual(grid.rows[0]);
  });

  it("a full-width row has no padding, so it reads as left", () => {
    const text = "A".repeat(BOARD_COLS);
    const { grid } = compileMessage(
      toBoardMessage(editorRows([{ text, align: "center" }]))
    );
    // No free columns means no padding to infer from — left is the honest answer.
    expect(gridToMessage(grid).rows[0]!.align).toBe("left");
    expect(rowText(grid.rows[0]!)).toBe(text);
  });
});

/* -------------------------------------------------------------------------- */
/* Round-trip stability                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The property that makes the history strip trustworthy: re-flipping a stored
 * grid must put the *same pixels* back on the board, and re-flipping the re-flip
 * must not drift further. `compileMessage → gridToMessage → compileMessage` is
 * therefore required to be a fixed point, not merely "close enough".
 */
describe("compileMessage → gridToMessage → compileMessage is stable", () => {
  const stable = (message: BoardMessage) => {
    const first = compileMessage(message).grid;
    const second = compileMessage(gridToMessage(first)).grid;
    const third = compileMessage(gridToMessage(second)).grid;
    expect(second).toEqual(first);
    expect(third).toEqual(second);
    return first;
  };

  it("holds for a centred row", () => {
    const grid = stable(
      toBoardMessage(editorRows([{ text: "CENTRED", align: "center" }]))
    );
    // Sanity: it really was centred, so the test isn't passing on a left row.
    expect(gridText(grid)[0]).toBe("        CENTRED         ");
  });

  it("holds for a right-aligned row", () => {
    const grid = stable(
      toBoardMessage(editorRows([{ text: "RIGHT", align: "right" }]))
    );
    expect(gridText(grid)[0]).toBe("                   RIGHT");
  });

  it("holds for a multi-colour row", () => {
    const grid = stable({
      rows: [
        {
          align: "left",
          segments: [
            { text: "RED", color: "red" },
            { text: "BLUE", color: "blue" },
            { text: "GREEN", color: "green" },
          ],
        },
      ],
    });
    expect(rowColorRuns(grid.rows[0]!)).toEqual([
      ["red", 3],
      ["blue", 4],
      ["green", 5],
    ]);
  });

  it("holds for a centred multi-colour row (alignment and colour at once)", () => {
    const grid = stable({
      rows: [
        {
          align: "center",
          segments: [
            { text: "AB", color: "yellow" },
            { text: "CD", color: "violet" },
          ],
        },
      ],
    });
    expect(gridText(grid)[0]).toBe("          ABCD          ");
    expect(rowColorRuns(grid.rows[0]!)).toEqual([
      ["yellow", 2],
      ["violet", 2],
    ]);
  });

  /**
   * `gridToMessage` reads alignment back out of a row's leading/trailing padding,
   * and a spread row has neither — so it comes back as `left` with its gaps
   * spelled out as white space segments. That is a *lossy* recovery of the intent
   * but a *lossless* recovery of the board, which is all a re-flip promises. The
   * grid equality is the assertion; the `left` is documented, not assumed.
   */
  it("holds for a spread row, which comes back as left with literal gaps", () => {
    const spread: BoardMessage = {
      rows: [
        {
          align: "spread",
          segments: [
            { text: "AIR QUALITY", color: "white" },
            { text: "GOOD", color: "green" },
          ],
        },
      ],
    };
    const grid = stable(spread);

    expect(gridText(grid)[0]).toBe("AIR QUALITY         GOOD");
    const recovered = gridToMessage(grid).rows[0]!;
    expect(recovered.align).toBe("left");
    expect(recovered.segments).toEqual([
      { text: "AIR QUALITY         ", color: "white" },
      { text: "GOOD", color: "green" },
    ]);
  });

  it("holds for a spread row that had to be clipped", () => {
    const grid = stable({
      rows: [
        {
          align: "spread",
          segments: [
            { text: "A".repeat(20), color: "white" },
            { text: "BBBB", color: "blue" },
          ],
        },
      ],
    });
    expect(gridText(grid)[0]).toBe(`${"A".repeat(20)} BBB`);
  });

  it("holds for an indented spread row, which comes back as right", () => {
    // Leading blanks are only expressible as alignment padding, so this recovers
    // as `right` — a different alignment, an identical board.
    const grid = stable({
      rows: [
        {
          align: "spread",
          segments: [
            { text: "  AB", color: "white" },
            { text: "CD", color: "violet" },
          ],
        },
      ],
    });
    expect(gridText(grid)[0]).toBe("  AB                  CD");
    expect(gridToMessage(grid).rows[0]!.align).toBe("right");
  });

  it("holds for a mixed board: every alignment, a gap and a blank row", () => {
    stable(
      toBoardMessage(
        editorRows([
          { text: "LEFT", align: "left" },
          { text: "MIDDLE", align: "center", color: "orange" },
          { text: "RIGHT", align: "right", color: "blue" },
          {},
          { text: "TWO WORDS", align: "center" },
          { text: "A".repeat(BOARD_COLS) },
        ])
      )
    );
  });
});
