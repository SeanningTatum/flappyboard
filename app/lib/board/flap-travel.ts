import { BOARD_CHARS, BLANK_COLOR, type BoardColor } from "@/lib/schemas/board";

/**
 * The physics of a split-flap character position, as pure arithmetic.
 *
 * A real tile is a stack of hinged flaps on a single-direction drum. It cannot
 * jump to a glyph — it can only advance one flap at a time, forward, wrapping
 * round the end of the stack back to the start. So showing `Z` when the tile
 * currently shows `A` costs 25 flaps; showing a blank when the tile shows `A`
 * costs nearly the whole revolution.
 *
 * Two consequences fall out of that, and they are the whole reason this module
 * exists rather than a per-tile CSS delay:
 *
 * 1. **Time is proportional to distance.** One flap costs one `STEP_MS`,
 *    whatever the glyph. A board-wide change therefore has tiles landing at
 *    genuinely different moments, spread across seconds — the stagger is
 *    *emergent*, not decorative. The old implementation faked it with
 *    `transition-delay: (row + col) * 14ms`, which rippled diagonally
 *    regardless of what the characters actually were.
 * 2. **A tile that isn't changing doesn't move.** Distance 0 means zero flaps,
 *    which means the animator never touches that DOM node.
 *
 * Everything here is total and browser-free: no `window`, no timers, no DOM.
 * The animator in `board-grid-view.tsx` is the only thing that knows about
 * frames, and it asks this module what to do.
 */

/* -------------------------------------------------------------------------- */
/* Timing constants                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Milliseconds per flap.
 *
 * Derived, not picked. The charset is 57 glyphs, so the longest possible travel
 * is 56 flaps (from a glyph to the one immediately *behind* it). The brief for
 * this board is that a worst-case travel lands inside a 3–5s window, which puts
 * the step rate between `3000/56 ≈ 54ms` and `5000/56 ≈ 89ms`. 72ms sits mid-band
 * at ~13.9 glyphs/second — fast enough to read as a blur of characters rather
 * than a slideshow, slow enough that a single glyph is genuinely on screen for
 * more than four frames at 60Hz (so the intermediate characters are *visible*,
 * which is the entire effect), and slow enough that the animator only has to
 * touch the DOM ~14 times per second per moving tile.
 */
export const FLAP_STEP_MS = 72;

/**
 * The final flap — the one that lands on the target — gets a real hinge
 * rotation rather than an instant cut, because that is the beat the eye actually
 * watches and it is the "clack into place" the whole animation is building to.
 * 200ms is the same order as the old single-flip duration (220ms), so a
 * one-flap change (`A` → `B`) looks exactly as it always did.
 */
export const FLAP_LAND_MS = 200;

/**
 * How many flaps a **colour-only** change costs.
 *
 * On the real object colour and glyph share one flap stack, so recolouring a
 * tile without changing its character is physically a full revolution — 57
 * flaps, ~4s. We deliberately don't do that. A phone painting a row red would
 * otherwise cost the same four seconds as rewriting the entire board, and would
 * spend them scrambling characters the reader is already reading. Five flaps is
 * enough to read unambiguously as "that tile moved" (it lands in
 * `4 × 72 + 200 = 488ms`), keeps the tile clattering with the rest of the board,
 * and does not destroy text that isn't changing.
 *
 * The compromise is honest and local: the five glyphs shown are the real next
 * five on the drum, but the tile lands back on the glyph it started from instead
 * of completing the revolution. It is a flutter, not a revolution.
 */
export const FLAP_COLOR_ONLY_STEPS = 5;

/** Number of glyphs on the drum. */
export const FLAP_CHAR_COUNT = BOARD_CHARS.length;

/** Longest possible travel: all the way round, less the one you're standing on. */
export const MAX_FLAP_STEPS = FLAP_CHAR_COUNT - 1;

/**
 * Worst case wall-clock for a single tile, and therefore for the board: the
 * first flap is shown immediately (at `t = 0`), so the *n*th flap begins at
 * `(n - 1) × FLAP_STEP_MS`, and the last one is a landing flip.
 *
 * `55 × 72 + 200 = 4160ms` — inside the 3–5s window, with room either side.
 */
export const MAX_TRAVEL_MS = (MAX_FLAP_STEPS - 1) * FLAP_STEP_MS + FLAP_LAND_MS;

/* -------------------------------------------------------------------------- */
/* Distance and sequence                                                      */
/* -------------------------------------------------------------------------- */

const CHAR_INDEX: ReadonlyMap<string, number> = new Map(
  BOARD_CHARS.split("").map((char, index) => [char, index] as const)
);

/**
 * Forward flaps from `from` to `to`, wrapping round the drum.
 *
 * Total by construction: the result is always in `[0, FLAP_CHAR_COUNT)`, so it
 * can never be negative and can never exceed `MAX_FLAP_STEPS`.
 *
 * Off-drum characters are a real path, not a theoretical one — a grid can be
 * rendered by a build whose charset has since changed. Two different fallbacks,
 * because the two directions mean different things:
 *
 * - An unknown **`from`** means "we don't know where this tile is resting", so
 *   we assume the blank at index 0. The travel is still a legal forward run and
 *   still ends on the target.
 * - An unknown **`to`** means "no flap in this stack can show that", so there is
 *   nowhere to travel to and the distance is 0. The animator falls back to a
 *   single landing flip for that case, so the tile still resolves visibly.
 */
export const flapDistance = (from: string, to: string): number => {
  const target = CHAR_INDEX.get(to);
  if (target === undefined) return 0;
  const start = CHAR_INDEX.get(from) ?? 0;
  return (target - start + FLAP_CHAR_COUNT) % FLAP_CHAR_COUNT;
};

/**
 * Every glyph the tile shows on its way to `to`, in order, ending on `to`.
 *
 * Empty exactly when the distance is 0 — an empty sequence is the encoding of
 * "this tile does not move". When it is non-empty its length is the distance and
 * its last element is the target; both are invariants the tests pin down.
 */
export const flapSequence = (from: string, to: string): ReadonlyArray<string> => {
  const steps = flapDistance(from, to);
  if (steps === 0) return [];
  const start = CHAR_INDEX.get(from) ?? 0;
  const out: string[] = new Array<string>(steps);
  for (let i = 1; i <= steps; i++) {
    out[i - 1] = BOARD_CHARS[(start + i) % FLAP_CHAR_COUNT]!;
  }
  return out;
};

/**
 * The colour-only flutter: `steps - 1` real forward glyphs, then back onto the
 * character the tile is already showing. Same invariant as `flapSequence` —
 * length is the step count, last element is the target — so the animator needs
 * no special case for it.
 */
const flutterSequence = (
  from: string,
  to: string,
  steps: number
): ReadonlyArray<string> => {
  const start = CHAR_INDEX.get(from) ?? 0;
  const out: string[] = new Array<string>(steps);
  for (let i = 0; i < steps - 1; i++) {
    out[i] = BOARD_CHARS[(start + 1 + i) % FLAP_CHAR_COUNT]!;
  }
  out[steps - 1] = to;
  return out;
};

/* -------------------------------------------------------------------------- */
/* Board-level plan                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What a tile is showing *right now*.
 *
 * Structurally looser than `BoardGrid` on purpose: the animator's `previous`
 * grid is not the last grid React was handed, it is what the 144 DOM nodes are
 * currently displaying — which mid-travel is neither the old grid nor the new
 * one. `BoardGrid` is assignable to this, so callers with a real grid need no
 * conversion.
 */
export interface DisplayedCell {
  readonly char: string;
  readonly color: BoardColor;
}

export interface DisplayedGrid {
  readonly rows: ReadonlyArray<ReadonlyArray<DisplayedCell>>;
}

/** Why a tile is moving. `color` tiles flutter; `char` tiles travel. */
export type FlapCellKind = "char" | "color";

export interface FlapCellPlan {
  readonly row: number;
  readonly col: number;
  readonly from: string;
  readonly to: string;
  readonly fromColor: BoardColor;
  readonly toColor: BoardColor;
  /** Flaps this tile turns. Always ≥ 1 — cells that don't move aren't in the plan. */
  readonly steps: number;
  /** When this tile has finished landing, relative to the start of the change. */
  readonly durationMs: number;
  /** Glyphs to show, one per step, last one the target. `length === steps`. */
  readonly sequence: ReadonlyArray<string>;
  readonly kind: FlapCellKind;
}

export interface FlapTravelPlan {
  readonly stepMs: number;
  readonly landMs: number;
  /** Step count of the slowest cell — the board's own step count. */
  readonly steps: number;
  /** When the whole board has settled. Equals the slowest cell's `durationMs`. */
  readonly durationMs: number;
  readonly movingCells: number;
  /** Only the cells that move. A still board plans nothing and touches nothing. */
  readonly perCell: ReadonlyArray<FlapCellPlan>;
}

export interface TravelPlanOptions {
  readonly stepMs?: number;
  readonly landMs?: number;
  readonly colorOnlySteps?: number;
}

/** Options cross a component boundary, so nothing is trusted to be a sane number. */
const positive = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

const nonNegative = (value: number | undefined, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;

const BLANK: DisplayedCell = { char: " ", color: BLANK_COLOR };

/**
 * The whole board's plan for one change.
 *
 * `previous === null` is first paint: React has already rendered the grid, so
 * nothing has anywhere to travel from and the plan is empty. That is also what
 * makes a page load silent and still rather than clattering through 144 tiles
 * the moment the TV wakes.
 */
export const travelPlan = (
  previous: DisplayedGrid | null,
  next: DisplayedGrid,
  opts?: TravelPlanOptions
): FlapTravelPlan => {
  const stepMs = positive(opts?.stepMs, FLAP_STEP_MS);
  const landMs = nonNegative(opts?.landMs, FLAP_LAND_MS);
  const colorOnlySteps = Math.max(
    1,
    Math.floor(positive(opts?.colorOnlySteps, FLAP_COLOR_ONLY_STEPS))
  );

  const durationFor = (steps: number): number => (steps - 1) * stepMs + landMs;

  if (previous === null) {
    return {
      stepMs,
      landMs,
      steps: 0,
      durationMs: 0,
      movingCells: 0,
      perCell: [],
    };
  }

  const perCell: FlapCellPlan[] = [];
  let maxSteps = 0;

  next.rows.forEach((row, rowIndex) => {
    const previousRow = previous.rows[rowIndex];
    row.forEach((cell, colIndex) => {
      const before = previousRow?.[colIndex] ?? BLANK;
      const charChanged = before.char !== cell.char;
      const colorChanged = before.color !== cell.color;
      if (!charChanged && !colorChanged) return;

      let steps: number;
      let sequence: ReadonlyArray<string>;
      let kind: FlapCellKind;

      if (charChanged) {
        kind = "char";
        steps = flapDistance(before.char, cell.char);
        sequence = flapSequence(before.char, cell.char);
      } else {
        kind = "color";
        steps = colorOnlySteps;
        sequence = flutterSequence(before.char, cell.char, colorOnlySteps);
      }

      // Distance 0 with a change to show means the target glyph isn't on the
      // drum. The tile still has to resolve, so it gets one landing flip.
      if (steps < 1 || sequence.length !== steps) {
        steps = 1;
        sequence = [cell.char];
      }

      if (steps > maxSteps) maxSteps = steps;

      perCell.push({
        row: rowIndex,
        col: colIndex,
        from: before.char,
        to: cell.char,
        fromColor: before.color,
        toColor: cell.color,
        steps,
        durationMs: durationFor(steps),
        sequence,
        kind,
      });
    });
  });

  return {
    stepMs,
    landMs,
    steps: maxSteps,
    durationMs: maxSteps === 0 ? 0 : durationFor(maxSteps),
    movingCells: perCell.length,
    perCell,
  };
};
