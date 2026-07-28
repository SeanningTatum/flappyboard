import { describe, expect, it } from "vitest";

import {
  FLAP_CHAR_COUNT,
  FLAP_COLOR_ONLY_STEPS,
  FLAP_LAND_MS,
  FLAP_STEP_MS,
  MAX_FLAP_STEPS,
  MAX_TRAVEL_MS,
  flapDistance,
  flapSequence,
  travelPlan,
  type DisplayedCell,
  type DisplayedGrid,
} from "../flap-travel";
import { blankGrid } from "../compile";
import {
  BOARD_CHARS,
  BOARD_COLS,
  BOARD_ROWS,
  type BoardColor,
  type BoardGrid,
} from "@/lib/schemas/board";

const CHARS = BOARD_CHARS.split("");

/** A grid built from row strings — every cell `white` unless a colour map says otherwise. */
const gridOf = (
  rows: ReadonlyArray<string>,
  color: BoardColor = "white"
): DisplayedGrid => ({
  rows: Array.from({ length: BOARD_ROWS }, (_, rowIndex) => {
    const text = (rows[rowIndex] ?? "").padEnd(BOARD_COLS, " ").slice(0, BOARD_COLS);
    return Array.from(
      { length: BOARD_COLS },
      (_, colIndex): DisplayedCell => ({ char: text[colIndex]!, color })
    );
  }),
});

const cellAt = (
  plan: ReturnType<typeof travelPlan>,
  row: number,
  col: number
) => plan.perCell.find((cell) => cell.row === row && cell.col === col);

describe("timing constants", () => {
  it("the charset is the drum, and the longest travel is one short of a full turn", () => {
    expect(FLAP_CHAR_COUNT).toBe(BOARD_CHARS.length);
    expect(MAX_FLAP_STEPS).toBe(FLAP_CHAR_COUNT - 1);
  });

  it("worst-case travel lands inside the 3–5s authenticity window", () => {
    expect(MAX_TRAVEL_MS).toBe((MAX_FLAP_STEPS - 1) * FLAP_STEP_MS + FLAP_LAND_MS);
    expect(MAX_TRAVEL_MS).toBeGreaterThanOrEqual(3_000);
    expect(MAX_TRAVEL_MS).toBeLessThanOrEqual(5_000);
  });

  it("the step rate is in the band the window implies (54–89ms per flap)", () => {
    expect(FLAP_STEP_MS * MAX_FLAP_STEPS).toBeGreaterThanOrEqual(3_000);
    expect(FLAP_STEP_MS * MAX_FLAP_STEPS).toBeLessThanOrEqual(5_000);
  });
});

describe("flapDistance", () => {
  it("is 0 for identical characters — a tile that isn't changing does not move", () => {
    for (const char of CHARS) expect(flapDistance(char, char)).toBe(0);
  });

  it("counts one step to the next glyph on the drum", () => {
    expect(flapDistance("A", "B")).toBe(1);
    expect(flapDistance(" ", "A")).toBe(1);
    expect(flapDistance("Z", "0")).toBe(1);
  });

  it("counts forward only — A→Z is 25, Z→A is the long way round", () => {
    expect(flapDistance("A", "Z")).toBe(25);
    expect(flapDistance("Z", "A")).toBe(FLAP_CHAR_COUNT - 25);
  });

  it("wraps: the last glyph is one step from the first", () => {
    const last = CHARS[CHARS.length - 1]!;
    expect(flapDistance(last, CHARS[0]!)).toBe(1);
    expect(flapDistance(CHARS[0]!, last)).toBe(MAX_FLAP_STEPS);
  });

  it("A→blank wraps nearly the whole drum", () => {
    expect(flapDistance("A", " ")).toBe(FLAP_CHAR_COUNT - 1);
  });

  it("is never negative and never exceeds the drum, for every ordered pair", () => {
    for (const from of CHARS) {
      for (const to of CHARS) {
        const distance = flapDistance(from, to);
        expect(distance).toBeGreaterThanOrEqual(0);
        expect(distance).toBeLessThanOrEqual(MAX_FLAP_STEPS);
        expect(Number.isInteger(distance)).toBe(true);
      }
    }
  });

  it("distance plus its reverse is a full turn for any distinct pair", () => {
    expect(flapDistance("A", "M") + flapDistance("M", "A")).toBe(FLAP_CHAR_COUNT);
    expect(flapDistance(" ", "?") + flapDistance("?", " ")).toBe(FLAP_CHAR_COUNT);
  });

  it("an unknown `from` is treated as resting on the blank at index 0", () => {
    expect(flapDistance("ß", "A")).toBe(flapDistance(" ", "A"));
    expect(flapDistance("", "A")).toBe(flapDistance(" ", "A"));
    expect(flapDistance("AB", "A")).toBe(flapDistance(" ", "A"));
  });

  it("an unknown `to` has nowhere to travel to, so it is 0", () => {
    expect(flapDistance("A", "ß")).toBe(0);
    expect(flapDistance("A", "")).toBe(0);
    expect(flapDistance("A", "ab")).toBe(0);
  });

  it("never throws for any input", () => {
    expect(() => flapDistance("", "")).not.toThrow();
    expect(() =>
      flapDistance(undefined as unknown as string, null as unknown as string)
    ).not.toThrow();
  });
});

describe("flapSequence", () => {
  it("is empty exactly when the distance is 0", () => {
    expect(flapSequence("A", "A")).toEqual([]);
    expect(flapSequence("A", "ß")).toEqual([]);
    expect(flapSequence("A", "B")).not.toEqual([]);
  });

  it("shows every intermediate glyph, in drum order", () => {
    expect(flapSequence("A", "E")).toEqual(["B", "C", "D", "E"]);
  });

  it("length always matches the distance", () => {
    for (const from of CHARS) {
      for (const to of CHARS) {
        expect(flapSequence(from, to)).toHaveLength(flapDistance(from, to));
      }
    }
  });

  it("last element is always the target, whenever the tile moves at all", () => {
    for (const from of CHARS) {
      for (const to of CHARS) {
        const sequence = flapSequence(from, to);
        if (sequence.length === 0) continue;
        expect(sequence[sequence.length - 1]).toBe(to);
      }
    }
  });

  it("every glyph it shows is on the drum, and none repeats", () => {
    const sequence = flapSequence("Z", "C");
    expect(sequence.length).toBeGreaterThan(1);
    for (const glyph of sequence) expect(BOARD_CHARS).toContain(glyph);
    expect(new Set(sequence).size).toBe(sequence.length);
  });

  it("wraps through the blank on the long way round", () => {
    const sequence = flapSequence("Z", "A");
    expect(sequence).toContain(" ");
    expect(sequence[sequence.length - 1]).toBe("A");
    expect(sequence).toHaveLength(FLAP_CHAR_COUNT - 25);
  });

  it("an unknown `from` still produces a legal run ending on the target", () => {
    const sequence = flapSequence("ß", "C");
    expect(sequence).toEqual(["A", "B", "C"]);
  });
});

describe("travelPlan", () => {
  const blank = blankGrid();

  it("first paint (previous === null) plans nothing and lasts no time", () => {
    const plan = travelPlan(null, gridOf(["HELLO"]));
    expect(plan.perCell).toEqual([]);
    expect(plan.movingCells).toBe(0);
    expect(plan.steps).toBe(0);
    expect(plan.durationMs).toBe(0);
  });

  it("an unchanged board plans nothing — no tile is touched", () => {
    const plan = travelPlan(blank, blank as BoardGrid as DisplayedGrid);
    expect(plan.movingCells).toBe(0);
    expect(plan.durationMs).toBe(0);
  });

  it("only changed cells appear in the plan", () => {
    const plan = travelPlan(gridOf(["AB"]), gridOf(["AC"]));
    expect(plan.movingCells).toBe(1);
    expect(plan.perCell[0]).toMatchObject({ row: 0, col: 1, from: "B", to: "C", steps: 1 });
  });

  it("each cell's sequence ends on its own target and matches its step count", () => {
    const plan = travelPlan(gridOf(["AAA"]), gridOf(["BZ "]));
    for (const cell of plan.perCell) {
      expect(cell.sequence).toHaveLength(cell.steps);
      expect(cell.sequence[cell.sequence.length - 1]).toBe(cell.to);
      expect(cell.steps).toBeGreaterThanOrEqual(1);
    }
    expect(cellAt(plan, 0, 0)!.steps).toBe(1); // A → B
    expect(cellAt(plan, 0, 1)!.steps).toBe(25); // A → Z
    expect(cellAt(plan, 0, 2)!.steps).toBe(FLAP_CHAR_COUNT - 1); // A → blank
  });

  it("the board's duration is exactly the slowest cell's", () => {
    const plan = travelPlan(gridOf(["AAA"]), gridOf(["BZ "]));
    const slowest = Math.max(...plan.perCell.map((cell) => cell.durationMs));
    expect(plan.durationMs).toBe(slowest);
    expect(plan.steps).toBe(Math.max(...plan.perCell.map((cell) => cell.steps)));
  });

  it("duration is proportional to distance: the stagger is emergent, not decorative", () => {
    const plan = travelPlan(gridOf(["AA"]), gridOf(["BE"]));
    const near = cellAt(plan, 0, 0)!;
    const far = cellAt(plan, 0, 1)!;
    expect(near.durationMs).toBe(FLAP_LAND_MS);
    expect(far.durationMs).toBe(3 * FLAP_STEP_MS + FLAP_LAND_MS);
    expect(far.durationMs).toBeGreaterThan(near.durationMs);
  });

  it("a worst-case cell anywhere on the board puts the board in the 3–5s window", () => {
    const plan = travelPlan(gridOf(["A"]), gridOf([" "]));
    expect(plan.durationMs).toBe(MAX_TRAVEL_MS);
    expect(plan.durationMs).toBeGreaterThanOrEqual(3_000);
    expect(plan.durationMs).toBeLessThanOrEqual(5_000);
  });

  it("a colour-only change flutters a short fixed distance and lands on the same glyph", () => {
    const plan = travelPlan(gridOf(["AB"], "white"), gridOf(["AB"], "red"));
    expect(plan.movingCells).toBe(BOARD_ROWS * BOARD_COLS);
    const cell = cellAt(plan, 0, 0)!;
    expect(cell.kind).toBe("color");
    expect(cell.steps).toBe(FLAP_COLOR_ONLY_STEPS);
    expect(cell.from).toBe("A");
    expect(cell.to).toBe("A");
    expect(cell.sequence).toEqual(["B", "C", "D", "E", "A"]);
    expect(cell.durationMs).toBeLessThan(1_000);
  });

  it("a colour-only change is far cheaper than a full revolution would be", () => {
    const flutter = travelPlan(gridOf(["A"], "white"), gridOf(["A"], "red"));
    expect(flutter.durationMs).toBeLessThan(MAX_TRAVEL_MS / 4);
  });

  it("a char change carries the colour with it and is kind `char`", () => {
    const plan = travelPlan(gridOf(["A"], "white"), gridOf(["C"], "green"));
    const cell = cellAt(plan, 0, 0)!;
    expect(cell.kind).toBe("char");
    expect(cell.fromColor).toBe("white");
    expect(cell.toColor).toBe("green");
    expect(cell.steps).toBe(2);
  });

  it("a target glyph that isn't on the drum still resolves in one landing flip", () => {
    const previous = gridOf(["A"]);
    const next: DisplayedGrid = {
      rows: previous.rows.map((row, rowIndex) =>
        row.map((cell, colIndex) =>
          rowIndex === 0 && colIndex === 0 ? { char: "ß", color: "white" } : cell
        )
      ),
    };
    const plan = travelPlan(previous, next);
    const cell = cellAt(plan, 0, 0)!;
    expect(cell.steps).toBe(1);
    expect(cell.sequence).toEqual(["ß"]);
    expect(cell.durationMs).toBe(FLAP_LAND_MS);
  });

  it("a previous grid missing rows or cells treats them as an unlit blank", () => {
    // `black` here so the untouched cells match the assumed blank exactly and
    // the only differences are the two real characters.
    const plan = travelPlan({ rows: [] }, gridOf(["AB"], "black"));
    expect(cellAt(plan, 0, 0)).toMatchObject({
      from: " ",
      fromColor: "black",
      to: "A",
      steps: 1,
    });
    expect(plan.movingCells).toBe(2);
    expect(cellAt(plan, 5, 0)).toBeUndefined(); // blank → blank, still doesn't move
  });

  it("mid-travel retarget: planning from what is on screen, not from the old grid", () => {
    // The tile is showing "M" (an intermediate glyph of an A→Z run) when a new
    // grid asking for "P" arrives. It must continue forward from M, three steps,
    // not restart from A.
    const plan = travelPlan(gridOf(["M"]), gridOf(["P"]));
    const cell = cellAt(plan, 0, 0)!;
    expect(cell.from).toBe("M");
    expect(cell.steps).toBe(3);
    expect(cell.sequence).toEqual(["N", "O", "P"]);
  });

  it("mid-travel retarget backwards wraps rather than reversing", () => {
    const plan = travelPlan(gridOf(["M"]), gridOf(["C"]));
    const cell = cellAt(plan, 0, 0)!;
    expect(cell.steps).toBe(flapDistance("M", "C"));
    expect(cell.steps).toBeGreaterThan(FLAP_CHAR_COUNT / 2);
    expect(cell.sequence[cell.sequence.length - 1]).toBe("C");
  });

  it("mid-travel retarget onto the glyph already showing stops the tile", () => {
    const plan = travelPlan(gridOf(["M"]), gridOf(["M"]));
    expect(plan.movingCells).toBe(0);
  });

  it("honours injected timings", () => {
    const plan = travelPlan(gridOf(["A"]), gridOf(["E"]), { stepMs: 10, landMs: 0 });
    expect(plan.stepMs).toBe(10);
    expect(plan.landMs).toBe(0);
    expect(plan.durationMs).toBe(30);
  });

  it("falls back to the defaults for nonsense timings rather than producing NaN", () => {
    const plan = travelPlan(gridOf(["A"]), gridOf(["E"]), {
      stepMs: Number.NaN,
      landMs: -5,
      colorOnlySteps: 0,
    });
    expect(plan.stepMs).toBe(FLAP_STEP_MS);
    expect(plan.landMs).toBe(FLAP_LAND_MS);
    expect(Number.isFinite(plan.durationMs)).toBe(true);
    expect(plan.durationMs).toBe(3 * FLAP_STEP_MS + FLAP_LAND_MS);
  });

  it("a colourOnlySteps of 1 degenerates to a single landing flip on the target", () => {
    const plan = travelPlan(gridOf(["A"], "white"), gridOf(["A"], "red"), {
      colorOnlySteps: 1,
    });
    const cell = cellAt(plan, 0, 0)!;
    expect(cell.steps).toBe(1);
    expect(cell.sequence).toEqual(["A"]);
  });

  it("a full-board rewrite never exceeds the worst case, however busy it is", () => {
    const previous = gridOf(["", "", "", "", "", ""]);
    const next = gridOf([
      "THE QUICK BROWN FOX JUMP",
      "ED OVER THE LAZY DOG 123",
      "456789!@#$()-+&=;:'\"%,.",
      "?/ FLAPPYBOARD IS ALIVE",
      "ZZZZZZZZZZZZZZZZZZZZZZZZ",
      "AAAAAAAAAAAAAAAAAAAAAAAA",
    ]);
    const plan = travelPlan(previous, next);
    expect(plan.movingCells).toBeGreaterThan(100);
    expect(plan.durationMs).toBeLessThanOrEqual(MAX_TRAVEL_MS);
    expect(plan.durationMs).toBeGreaterThanOrEqual(3_000);
    for (const cell of plan.perCell) {
      expect(cell.durationMs).toBeLessThanOrEqual(plan.durationMs);
    }
  });

  it("plans every cell of the board at most once", () => {
    const plan = travelPlan(gridOf([""]), gridOf(["X".repeat(BOARD_COLS)]));
    const keys = plan.perCell.map((cell) => `${cell.row}-${cell.col}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(plan.perCell.length).toBeLessThanOrEqual(BOARD_ROWS * BOARD_COLS);
  });
});
