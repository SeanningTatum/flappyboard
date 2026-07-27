import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  BLANK_CELL,
  blankGrid,
  blankRow,
  compileMessage,
  compileToGrid,
  normalizeText,
} from "../compile";
import {
  BOARD_COLS,
  BOARD_ROWS,
  decodeBoardGrid,
  type BoardAlign,
  type BoardCellRow,
  type BoardGrid,
  type BoardMessage,
  type BoardSegment,
} from "@/lib/schemas/board";

const seg = (text: string, color: BoardSegment["color"] = "white"): BoardSegment => ({
  text,
  color,
});

const msg = (
  ...rows: ReadonlyArray<{
    align?: BoardAlign;
    segments: ReadonlyArray<BoardSegment>;
  }>
): BoardMessage => ({
  rows: rows.map((row) => ({ align: row.align ?? "left", segments: row.segments })),
});

const render = (row: BoardCellRow): string => row.map((cell) => cell.char).join("");

const renderGrid = (grid: BoardGrid): ReadonlyArray<string> =>
  grid.rows.map(render);

const expectExactShape = (grid: BoardGrid) => {
  expect(grid.rows).toHaveLength(BOARD_ROWS);
  for (const row of grid.rows) {
    expect(row).toHaveLength(BOARD_COLS);
  }
  expect(Either.isRight(decodeBoardGrid(grid))).toBe(true);
};

describe("normalizeText", () => {
  it("uppercases and strips diacritics", () => {
    expect(normalizeText("Café Niño")).toBe("CAFE NINO");
  });

  it("maps near-miss characters onto real flaps", () => {
    expect(normalizeText("a_b*c[d]e|f")).toBe("A-B+C(D)E/F");
  });

  it("drops characters no flap can show", () => {
    expect(normalizeText("HI 🎉 THERE")).toBe("HI  THERE");
  });

  it("turns newlines and tabs into spaces", () => {
    expect(normalizeText("A\nB\tC")).toBe("A B C");
  });
});

describe("compileMessage — the 6x24 invariant", () => {
  const corpus: ReadonlyArray<BoardMessage> = [
    msg(),
    msg({ segments: [] }),
    msg({ segments: [seg("")] }),
    msg({ segments: [seg("HELLO")] }),
    msg({ segments: [seg("🎉🎉🎉")] }),
    msg({ segments: [seg("A".repeat(200))] }),
    msg({ segments: [seg("SUPERCALIFRAGILISTICEXPIALIDOCIOUS")] }),
    msg(
      { segments: [seg("ONE")] },
      { segments: [seg("TWO")] },
      { segments: [seg("THREE")] },
      { segments: [seg("FOUR")] },
      { segments: [seg("FIVE")] },
      { segments: [seg("SIX")] }
    ),
    msg({ align: "center", segments: [seg("CENTERED")] }),
    msg({ align: "right", segments: [seg("RIGHT")] }),
    msg({ segments: [seg("  ", "red"), seg(" TILES", "blue")] }),
    msg({ segments: Array.from({ length: 24 }, () => seg("X", "green")) }),
  ];

  it("emits exactly 6 rows of 24 cells for every input in the corpus", () => {
    for (const message of corpus) {
      expectExactShape(compileToGrid(message));
    }
  });

  it("blankGrid is itself a valid empty board", () => {
    expectExactShape(blankGrid());
    expect(renderGrid(blankGrid())).toEqual(Array(BOARD_ROWS).fill(" ".repeat(BOARD_COLS)));
  });
});

describe("compileMessage — layout", () => {
  it("left-aligns by default and pads with blank cells", () => {
    const { grid } = compileMessage(msg({ segments: [seg("HI")] }));
    expect(renderGrid(grid)[0]).toBe("HI" + " ".repeat(BOARD_COLS - 2));
    expect(grid.rows[0]![2]).toEqual(BLANK_CELL);
  });

  it("centers with the extra cell on the right", () => {
    const { grid } = compileMessage(msg({ align: "center", segments: [seg("ABC")] }));
    // 24 - 3 = 21 free -> 10 left, 11 right
    expect(renderGrid(grid)[0]).toBe(" ".repeat(10) + "ABC" + " ".repeat(11));
  });

  it("right-aligns", () => {
    const { grid } = compileMessage(msg({ align: "right", segments: [seg("END")] }));
    expect(renderGrid(grid)[0]).toBe(" ".repeat(BOARD_COLS - 3) + "END");
  });

  it("keeps an empty row as a blank board row instead of collapsing it", () => {
    const { grid } = compileMessage(
      msg({ segments: [seg("TOP")] }, { segments: [] }, { segments: [seg("BOTTOM")] })
    );
    const rows = renderGrid(grid);
    expect(rows[0]!.trimEnd()).toBe("TOP");
    expect(rows[1]!.trim()).toBe("");
    expect(rows[2]!.trimEnd()).toBe("BOTTOM");
  });
});

describe("compileMessage — wrapping", () => {
  it("word-wraps a long row onto the next board row", () => {
    const { grid, truncated } = compileMessage(
      msg({ segments: [seg("THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG")] })
    );
    const rows = renderGrid(grid);
    expect(rows[0]).toBe("THE QUICK BROWN FOX".padEnd(BOARD_COLS, " "));
    expect(rows[1]).toBe("JUMPS OVER THE LAZY DOG".padEnd(BOARD_COLS, " "));
    expect(truncated).toBe(false);
  });

  it("hard-splits a single word longer than the board", () => {
    const { grid } = compileMessage(msg({ segments: [seg("A".repeat(30))] }));
    const rows = renderGrid(grid);
    expect(rows[0]).toBe("A".repeat(24));
    expect(rows[1]).toBe("A".repeat(6).padEnd(BOARD_COLS, " "));
  });

  it("reports dropped lines when content exceeds six rows", () => {
    const long = msg({ segments: [seg(Array.from({ length: 40 }, () => "WORD").join(" "))] });
    const result = compileMessage(long);
    expectExactShape(result.grid);
    expect(result.droppedLines).toBeGreaterThan(0);
    expect(result.truncated).toBe(true);
  });

  it("counts characters dropped by the charset", () => {
    const result = compileMessage(msg({ segments: [seg("OK 🎉🎉")] }));
    expect(result.droppedChars).toBe(2);
    expect(result.truncated).toBe(true);
  });
});

describe("compileMessage — colour", () => {
  it("normalises uncoloured spaces to blank tiles", () => {
    const { grid } = compileMessage(msg({ segments: [seg("A B")] }));
    expect(grid.rows[0]![1]).toEqual(BLANK_CELL);
  });

  it("treats a coloured space as a tile that survives wrapping", () => {
    const { grid } = compileMessage(
      msg({ segments: [seg("   ", "red"), seg("HI", "yellow")] })
    );
    const row = grid.rows[0]!;
    expect(row.slice(0, 3).map((cell) => cell.color)).toEqual(["red", "red", "red"]);
    expect(row[3]!).toEqual({ char: "H", color: "yellow" });
  });

  it("carries per-segment colour through to the cells", () => {
    const { grid } = compileMessage(
      msg({ segments: [seg("GO", "green"), seg(" STOP", "red")] })
    );
    const row = grid.rows[0]!;
    expect(row[0]!.color).toBe("green");
    expect(row[3]!).toEqual({ char: "S", color: "red" });
  });
});

/* -------------------------------------------------------------------------- */
/* Colour applies to glyphs — the HAPPY#FRIDAY! rule                          */
/* -------------------------------------------------------------------------- */

/** Columns that are lit: anything that is not the unlit blank cell. */
const litColumns = (row: BoardCellRow): ReadonlyArray<number> =>
  row.flatMap((cell, col) =>
    cell.char === " " && cell.color === "black" ? [] : [col]
  );

describe("compileMessage — colour applies to glyphs, not to gaps", () => {
  it("leaves the gap between two words of a coloured segment unlit", () => {
    // The reported defect: `HAPPY#FRIDAY!`, a lit green tile where a real board
    // shows an unlit card.
    const { grid } = compileMessage(
      msg({ segments: [seg("HAPPY FRIDAY!", "green")] })
    );
    const row = grid.rows[0]!;

    expect(render(row).trimEnd()).toBe("HAPPY FRIDAY!");
    expect(row[5]!).toEqual(BLANK_CELL);
    expect(litColumns(row)).toEqual([0, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("is identical to the same text in white, cell for cell but for the colour", () => {
    const green = compileMessage(msg({ segments: [seg("A B C", "green")] })).grid
      .rows[0]!;
    const white = compileMessage(msg({ segments: [seg("A B C")] })).grid.rows[0]!;

    expect(litColumns(green)).toEqual(litColumns(white));
    expect(render(green)).toBe(render(white));
  });

  it("still lights a segment that is entirely spaces — the border primitive", () => {
    const { grid } = compileMessage(
      msg({ segments: [seg("      ", "violet")] })
    );
    const row = grid.rows[0]!;

    expect(row.slice(0, 6).map((cell) => cell.color)).toEqual(
      Array(6).fill("violet")
    );
    expect(litColumns(row)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("still fills a whole row from a 24-space coloured segment — the bar", () => {
    const { grid, truncated } = compileMessage(
      msg({ segments: [seg(" ".repeat(BOARD_COLS), "orange")] })
    );

    expect(grid.rows[0]!.every((cell) => cell.color === "orange")).toBe(true);
    expect(grid.rows[0]!).toHaveLength(BOARD_COLS);
    expect(truncated).toBe(false);
  });

  it("still lights a one-space coloured segment — what a painted cell becomes", () => {
    const { grid } = compileMessage(
      msg({ segments: [seg("OK"), seg(" ", "red")] })
    );
    expect(grid.rows[0]![2]!).toEqual({ char: " ", color: "red" });
  });

  it("treats a segment of tabs as all spaces, since normalise gets there first", () => {
    const { grid } = compileMessage(msg({ segments: [seg("\t\t", "blue")] }));
    expect(grid.rows[0]!.slice(0, 2)).toEqual([
      { char: " ", color: "blue" },
      { char: " ", color: "blue" },
    ]);
  });

  /**
   * The wrap interaction the rule change had to be checked against. A separator
   * space is its own `gap` token and collapses at a wrap boundary; a lit space is
   * part of a `word` token and does not. Recategorising a coloured segment's
   * interior spaces therefore changes how that segment wraps — and it changes it
   * to the way white text has always wrapped, which is the point.
   */
  it("word-wraps a long coloured segment instead of hard-splitting it", () => {
    const text = "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG";
    const { grid: green } = compileMessage(msg({ segments: [seg(text, "green")] }));
    const { grid: white } = compileMessage(msg({ segments: [seg(text)] }));

    expect(renderGrid(green)).toEqual(renderGrid(white));
    expect(renderGrid(green)[0]).toBe("THE QUICK BROWN FOX".padEnd(BOARD_COLS));
    expect(renderGrid(green)[1]).toBe(
      "JUMPS OVER THE LAZY DOG".padEnd(BOARD_COLS)
    );
    // Every lit cell is still green — only the gaps changed category.
    for (const row of green.rows) {
      for (const cell of row) {
        expect(cell.color).toBe(cell.char === " " ? "black" : "green");
      }
    }
  });

  it("collapses a coloured segment's space at the wrap boundary itself", () => {
    // 24 columns exactly, then a space, then more: the space is the boundary and
    // must not survive as a lit tile at column 0 of the next row.
    const { grid } = compileMessage(
      msg({ segments: [seg(`${"A".repeat(24)} BB`, "yellow")] })
    );

    expect(render(grid.rows[0]!)).toBe("A".repeat(24));
    expect(render(grid.rows[1]!)).toBe("BB".padEnd(BOARD_COLS));
    expect(grid.rows[1]![0]!).toEqual({ char: "B", color: "yellow" });
  });

  it("does not light a coloured segment's trailing spaces at a row's end", () => {
    const { grid } = compileMessage(msg({ segments: [seg("HI   ", "red")] }));
    expect(litColumns(grid.rows[0]!)).toEqual([0, 1]);
  });

  it("keeps a writer's explicit lit gap when it is its own segment", () => {
    // The escape hatch: a lit gap inside coloured text is sayable, and it is what
    // painting that gap produces.
    const { grid } = compileMessage(
      msg({
        segments: [seg("HAPPY", "green"), seg(" ", "green"), seg("FRIDAY", "green")],
      })
    );
    expect(litColumns(grid.rows[0]!)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(grid.rows[0]![5]!).toEqual({ char: " ", color: "green" });
  });
});

/* -------------------------------------------------------------------------- */
/* spread                                                                     */
/* -------------------------------------------------------------------------- */

/** The column of the last cell that is actually lit — the flush-right measure. */
const lastLitColumn = (row: BoardCellRow): number => {
  for (let col = row.length - 1; col >= 0; col -= 1) {
    const cell = row[col]!;
    if (cell.char !== " " || cell.color !== "black") return col;
  }
  return -1;
};

describe("compileMessage — spread", () => {
  it("puts the first segment flush left and the last flush right", () => {
    const { grid, truncated } = compileMessage(
      msg({ align: "spread", segments: [seg("RAIN"), seg("30%", "orange")] })
    );
    const row = grid.rows[0]!;

    expect(render(row)).toBe(`RAIN${" ".repeat(17)}30%`);
    // The defect this alignment exists to fix, measured the way the bug was seen.
    expect(lastLitColumn(row)).toBe(BOARD_COLS - 1);
    expect(row[0]!).toEqual({ char: "R", color: "white" });
    expect(row[23]!).toEqual({ char: "%", color: "orange" });
    expect(truncated).toBe(false);
    expectExactShape(grid);
  });

  it("spaces three segments evenly, remainder to the leftmost gaps", () => {
    // 3 content + 21 free over 2 gaps = 10 each with 1 left over, and the extra
    // column goes to the first gap: A + 11 + B + 10 + C = 24.
    const { grid } = compileMessage(
      msg({ align: "spread", segments: [seg("A"), seg("B"), seg("C")] })
    );

    expect(render(grid.rows[0]!)).toBe(
      `A${" ".repeat(11)}B${" ".repeat(10)}C`
    );
  });

  it("spaces three equal segments with no remainder", () => {
    const { grid } = compileMessage(
      msg({
        align: "spread",
        segments: [seg("BA"), seg("OK", "green"), seg("12", "red")],
      })
    );

    expect(render(grid.rows[0]!)).toBe(`BA${" ".repeat(9)}OK${" ".repeat(9)}12`);
    expect(lastLitColumn(grid.rows[0]!)).toBe(BOARD_COLS - 1);
  });

  it("fits exactly when the content plus one gap is the whole board", () => {
    const { grid, truncated, droppedChars } = compileMessage(
      msg({ align: "spread", segments: [seg("A".repeat(20)), seg("BBB")] })
    );

    expect(render(grid.rows[0]!)).toBe(`${"A".repeat(20)} BBB`);
    expect(truncated).toBe(false);
    expect(droppedChars).toBe(0);
  });

  it("clips one column rather than wrapping when it is one over", () => {
    const { grid, truncated, droppedChars, droppedLines } = compileMessage(
      msg({ align: "spread", segments: [seg("A".repeat(20)), seg("BBBB")] })
    );

    // 24 content + a collapsed 1-column gap = 25, so exactly one column falls off.
    expect(render(grid.rows[0]!)).toBe(`${"A".repeat(20)} BBB`);
    expect(render(grid.rows[1]!)).toBe(" ".repeat(BOARD_COLS));
    expect(droppedChars).toBe(1);
    expect(droppedLines).toBe(0);
    expect(truncated).toBe(true);
  });

  it("never wraps, however far over it goes — the SKY / CLOUDY regression", () => {
    const { grid } = compileMessage(
      msg(
        { align: "spread", segments: [seg("SKY"), seg("PARTLY CLOUDY WITH SHOWERS", "blue")] },
        { align: "left", segments: [seg("NEXT")] }
      )
    );

    // The value stays on its own row and the following row is still the next row.
    expect(render(grid.rows[0]!).startsWith("SKY ")).toBe(true);
    expect(render(grid.rows[1]!)).toBe("NEXT".padEnd(BOARD_COLS));
  });

  it("is identical to left for a single segment", () => {
    const segments = [seg("HELLO", "yellow")];
    expect(compileToGrid(msg({ align: "spread", segments }))).toEqual(
      compileToGrid(msg({ align: "left", segments }))
    );
  });

  it("is a blank row when there is nothing to lay out", () => {
    const { grid, truncated } = compileMessage(
      msg({ align: "spread", segments: [] })
    );
    expect(grid.rows[0]!).toEqual(blankRow());
    expect(truncated).toBe(false);
  });

  it("ignores segments that normalise away instead of giving them a gap", () => {
    // The emoji-only segment is zero cells wide, so this is a two-segment row.
    const { grid } = compileMessage(
      msg({ align: "spread", segments: [seg("HI"), seg("🎉"), seg("OK", "green")] })
    );

    expect(render(grid.rows[0]!)).toBe(`HI${" ".repeat(20)}OK`);
  });

  it("leaves the gap unlit next to a coloured segment", () => {
    const { grid } = compileMessage(
      msg({ align: "spread", segments: [seg("A", "red"), seg("B", "violet")] })
    );
    const row = grid.rows[0]!;

    // A coloured space is a lit tile, so a gap that picked up either segment's
    // colour would draw a bright bar between the label and its value.
    for (let col = 1; col <= 22; col += 1) {
      expect(row[col]!).toEqual(BLANK_CELL);
    }
    expect(row[0]!.color).toBe("red");
    expect(row[23]!.color).toBe("violet");
  });

  it("measures gaps after normalising, not as typed", () => {
    // "ü" folds to one cell and the emoji drops to none, so a gap sized off the
    // raw string would be two columns wrong.
    const { grid } = compileMessage(
      msg({ align: "spread", segments: [seg("zürich 🌧"), seg("4", "blue")] })
    );

    expect(render(grid.rows[0]!)).toBe(`ZURICH ${" ".repeat(16)}4`);
    expect(lastLitColumn(grid.rows[0]!)).toBe(BOARD_COLS - 1);
  });

  it("counts a coloured all-space segment as content, since it is lit", () => {
    const { grid } = compileMessage(
      msg({
        align: "spread",
        segments: [seg("AA"), seg("  ", "red"), seg("BB", "green")],
      })
    );
    const row = grid.rows[0]!;

    expect(row[0]!.char).toBe("A");
    expect(row.filter((cell) => cell.color === "red")).toHaveLength(2);
    expect(lastLitColumn(row)).toBe(BOARD_COLS - 1);
    expect(row[23]!).toEqual({ char: "B", color: "green" });
  });

  it("keeps six spread rows as six rows", () => {
    const { grid, droppedLines } = compileMessage(
      msg(
        ...Array.from({ length: BOARD_ROWS }, () => ({
          align: "spread" as const,
          segments: [seg("LABEL"), seg("VALUE", "blue")],
        }))
      )
    );

    expect(droppedLines).toBe(0);
    for (const row of grid.rows) {
      expect(lastLitColumn(row)).toBe(BOARD_COLS - 1);
    }
    expectExactShape(grid);
  });

  it("renders the whole failing weather board flush to the right edge", () => {
    const { grid, truncated } = compileMessage(
      msg(
        { align: "center", segments: [seg("OSLO WEATHER")] },
        { align: "spread", segments: [seg("TEMP"), seg("18°", "blue")] },
        { align: "spread", segments: [seg("SKY"), seg("CLOUDY", "white")] },
        { align: "spread", segments: [seg("RAIN"), seg("30%", "orange")] },
        { align: "spread", segments: [seg("AIR QUALITY"), seg("GOOD", "green")] }
      )
    );

    expect(renderGrid(grid)).toEqual([
      "      OSLO WEATHER      ",
      "TEMP                 18°",
      "SKY               CLOUDY",
      "RAIN                 30%",
      "AIR QUALITY         GOOD",
      "                        ",
    ]);
    expect(truncated).toBe(false);
    for (const index of [1, 2, 3, 4]) {
      expect(lastLitColumn(grid.rows[index]!)).toBe(BOARD_COLS - 1);
    }
  });
});
