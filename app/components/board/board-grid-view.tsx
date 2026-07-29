import { useEffect, useMemo, useRef } from "react";

import { cn } from "@/lib/utils";
import {
  FLAP_LAND_MS,
  FLAP_STEP_MS,
  travelPlan,
  type DisplayedCell,
  type DisplayedGrid,
  type FlapTravelPlan,
} from "@/lib/board/flap-travel";
import {
  BOARD_COLS,
  BOARD_ROWS,
  type BoardColor,
  type BoardGrid,
} from "@/lib/schemas/board";
import { BoardFrame, MASK_FILL } from "./board-frame";
import {
  FLAP_FACE_ATTR,
  FLAP_GLYPH_ATTR,
  FLAP_HIDDEN_TRANSFORM,
  FLAP_REST_TRANSFORM,
  FLAP_TRAVEL_TILT,
  FlapTile,
  TILE_COLORS,
} from "./flap-tile";

/**
 * The whole board — enclosure and tile field — sized to a TV with no JS
 * measurement.
 *
 * Sizing derivation: a split-flap tile is roughly 1 wide × 2 tall, so 24 × 6
 * tiles make a field of aspect 24 : 12 = **2 : 1**. On a 16:9 screen (1.78 : 1)
 * that is width-bound.
 *
 * The field now sits inside a bezel (`BoardFrame`), so the width available to it
 * is the viewport less `2 × BEZEL`, and the height is the viewport less the same
 * — whichever binds first. `min()` expresses that with no measurement, exactly as
 * before. Width and height are both stated (rather than leaning on
 * `aspect-ratio` alone) because the Tizen build we target predates
 * `aspect-ratio`; the declared ratio agrees with the stated numbers, so the
 * layout is identical whether or not the engine honours it.
 *
 * The bezel is a *floor*, not a fixed border: whichever axis doesn't bind ends up
 * with more frame than `BEZEL`. On 16:9 that's the vertical axis, so the top and
 * bottom bezels come out ~2× the sides — which is what a real unit looks like,
 * and it leaves room for the etched wordmark. Frame plus field always equal the
 * viewport exactly, so there is nothing to scroll.
 *
 * The glyph then scales off the same `min()` expression, so type size tracks
 * tile size on any screen — no breakpoints, no resize listener.
 *
 * This component also owns the **animation loop** — see `useFlapAnimation` at the
 * bottom of the file. That belongs here rather than in `FlapTile` for the reason
 * that shapes the whole design: there is exactly one loop for all 144 tiles.
 */

/**
 * Minimum frame around the field. A real unit spends ~7% of its width on frame and
 * comes out with a side:top bezel ratio near 1 : 1.05. Because the field is 2:1
 * inside a 16:9 panel, the vertical axis always ends up with the surplus, so the
 * ratio is only as even as this number is large — 7vmin lands it at ~1 : 1.3 and
 * costs the glyphs ~8%, which is where the trade stops being worth it.
 */
const BEZEL = "7vmin";

/** Field is 2:1 → width is bound by the viewport (less bezel) on one axis or the other. */
const FIELD_WIDTH = "min(100vw - 14vmin, 200vh - 28vmin)";
const FIELD_HEIGHT = "min(50vw - 7vmin, 100vh - 14vmin)";

/**
 * Glyph size, derived from field width so type tracks tile size on any screen —
 * no breakpoints, no resize listener.
 *
 * The divisor is set by the widest character the board can show. There are 24
 * columns, `W` in Inter at 600 is ~0.92em of advance, and `flap-tile` condenses to
 * 0.85 and holds the flap to 0.9 × 0.82 = 74% of the column pitch. So the largest
 * size at which a `W` still lands inside its flap is `pitch × 0.74 / (0.92 × 0.85)`
 * ≈ `pitch × 0.94`, i.e. field width / 26. Cap height then comes out ~61% of the
 * flap — a shade over the real ~55%, which is the one place fidelity gives way to
 * a TV that has to be read from the far side of a room. Clamped so a tiny dev
 * window stays readable and a 4K TV doesn't overshoot.
 */
const GLYPH_SIZE =
  "clamp(0.5rem, calc(min(100vw - 14vmin, 200vh - 28vmin) / 26), 14rem)";

/**
 * The inline mirror's glyph size: the same `field width / 26` derivation as the
 * TV, but off the *container* instead of the viewport. `cqw` is the reason the
 * variant wrapper carries `container-type: inline-size`. Phone browsers only —
 * the Tizen path (`display`) never sees a container query, which is a feature
 * `flap-tile.tsx` deliberately avoids for the TV.
 */
const INLINE_GLYPH_SIZE = "calc(100cqw / 26)";

export interface BoardGridViewProps {
  readonly grid: BoardGrid;
  readonly className?: string;
  /**
   * `display` (default) is the TV: the field and its `BoardFrame` enclosure
   * sized to the viewport exactly as they always have been. `inline` is the
   * phone mirror: no enclosure (the controller's console plate is the
   * enclosure), field sized to its container, glyphs off container width.
   * The animation loop is sizing-agnostic and identical for both.
   */
  readonly variant?: "display" | "inline";
  /**
   * Called from the animation loop, every frame, with the number of tiles still
   * in motion — 0 on the frame the board settles. Drives the clatter (see
   * `FlapPlayer.tick`). Kept as a callback rather than the board reaching for
   * the player itself so this component stays free of audio and of the socket.
   */
  readonly onMotion?: (movingCells: number) => void;
}

export function BoardGridView({
  grid,
  className,
  variant = "display",
  onMotion,
}: BoardGridViewProps) {
  const fieldRef = useFlapAnimation(grid, onMotion);

  /**
   * The 144 tiles are structurally immutable: same count, same order, forever.
   * Memoising the field on `grid` means React reconciles 144 tile roots (two
   * `data-*` attributes each) per update and stops there — the faces below are
   * memoised inside `FlapTile` on a ref-stable value, so they are never visited.
   */
  const tiles = useMemo(
    () =>
      grid.rows.map((row, rowIndex) =>
        row.map((cell, colIndex) => (
          <FlapTile
            key={`${rowIndex}-${colIndex}`}
            char={cell.char}
            color={cell.color}
          />
        ))
      ),
    [grid]
  );

  const field = (
    <div
      ref={fieldRef}
      // No `gap`: the lattice is not a gap showing the page behind, it is the
      // frame's own mask showing through the space each flap leaves inside its
      // cell (see `TILE_INSET_*` in flap-tile). That is why this element has no
      // background of its own — the mask is one continuous surface, exactly as
      // it is on the real object, and the old gap-plus-radius combination is
      // what produced the decorative dot lattice.
      className={cn("grid")}
      style={
        variant === "inline"
          ? {
              width: "100%",
              aspectRatio: `${BOARD_COLS} / ${BOARD_ROWS * 2}`,
              fontSize: INLINE_GLYPH_SIZE,
              gridTemplateColumns: `repeat(${BOARD_COLS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${BOARD_ROWS}, minmax(0, 1fr))`,
            }
          : {
              width: FIELD_WIDTH,
              height: FIELD_HEIGHT,
              aspectRatio: `${BOARD_COLS} / ${BOARD_ROWS * 2}`,
              fontSize: GLYPH_SIZE,
              gridTemplateColumns: `repeat(${BOARD_COLS}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${BOARD_ROWS}, minmax(0, 1fr))`,
              // Keeps the field honest if a future caller ever renders the frame at
              // a size the bezel can't cover.
              maxWidth: `calc(100% - 2 * ${BEZEL})`,
            }
      }
      data-testid="board-grid"
      role="img"
      aria-label={gridToText(grid)}
    >
      {tiles}
    </div>
  );

  if (variant === "inline") {
    // The mask surface the TV gets from `BoardFrame`, quoted flat: the gaps
    // between flaps must read as painted metal, not as the console plate behind.
    return (
      <div
        className={className}
        style={{ containerType: "inline-size", backgroundImage: MASK_FILL }}
        data-testid="board-mirror"
      >
        {field}
      </div>
    );
  }

  return <BoardFrame className={className}>{field}</BoardFrame>;
}

/**
 * The board is a picture of text, so it gets a text alternative. Trailing blanks
 * are trimmed per row so a mostly-empty board doesn't read as a wall of spaces.
 */
const gridToText = (grid: BoardGrid): string =>
  grid.rows
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .replace(/\s+$/, "")
    )
    .join("\n");

/* -------------------------------------------------------------------------- */
/* The animation loop                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One `requestAnimationFrame` loop for the whole board.
 *
 * The arithmetic that forces this shape: a worst-case change has 144 tiles each
 * turning up to 56 flaps at ~14 flaps/second — about 2,000 glyph changes a
 * second, on a several-years-old Chromium in a TV. So:
 *
 * - **One loop, not 144.** Every tile shares a single start timestamp and derives
 *   its own step index from elapsed time, so the loop is `O(moving tiles)` per
 *   frame with no timers, no per-tile scheduling and nothing to clear.
 * - **React is not in the per-step path at all.** It owns the target grid and two
 *   `data-*` attributes per tile; the loop owns `textContent`, `transform`,
 *   `opacity`, `zIndex` and the two colour properties on the faces, addressed
 *   through a ref array built once.
 * - **Writes only happen on step boundaries.** At 72ms/step and 60Hz the loop
 *   does nothing on roughly three frames in four: it computes one elapsed time,
 *   compares one integer per moving tile, and returns. The DOM cost of the frames
 *   that *do* write is two style writes plus one text write per moving tile.
 *
 * What that trades away, deliberately: the intermediate flaps are instant cuts
 * rather than interpolated rotations. Interpolating them would mean restarting
 * 288 CSS transitions ~14 times a second (≈4,300 animation starts/second), or
 * writing a transform per tile on every frame (~8,600 writes/second) — either of
 * which is an order of magnitude more main-thread work than the whole rest of the
 * loop. A split-flap at speed reads as a hard cut anyway; the interpolated hinge
 * is spent where it is actually watched, on the landing flip.
 */

/** What one tile's DOM looks like to the loop. */
interface TileHandle {
  readonly faces: readonly [HTMLElement, HTMLElement];
  readonly glyphs: readonly [HTMLElement, HTMLElement];
  /** Which face is showing. The other one sits at `rotateX(90deg)`, invisible. */
  active: 0 | 1;
  /** The glyph and pigment **currently on screen** — not the target. */
  char: string;
  color: BoardColor;
  /** True between the first flap and the landing flip. */
  travelling: boolean;
}

/** One tile's outstanding work. `taken` is how many flaps it has already turned. */
interface FlapSchedule {
  readonly handle: TileHandle;
  readonly sequence: ReadonlyArray<string>;
  readonly steps: number;
  readonly toColor: BoardColor;
  taken: number;
  done: boolean;
}

const glyphText = (char: string): string => (char === " " ? "" : char);

const paintFace = (
  face: HTMLElement,
  glyph: HTMLElement,
  char: string,
  color: BoardColor
): void => {
  const pigment = TILE_COLORS[color] ?? TILE_COLORS.black;
  glyph.textContent = glyphText(char);
  face.style.backgroundColor = pigment.fill;
  face.style.color = pigment.ink;
};

/**
 * One intermediate flap: swap the glyph on the face that is already showing and
 * tip the card. No transition, so it is a cut — the browser does no interpolation
 * and starts no animation.
 */
const travelStep = (handle: TileHandle, char: string, step: number): void => {
  const face = handle.faces[handle.active]!;
  handle.glyphs[handle.active]!.textContent = glyphText(char);
  face.style.transform = FLAP_TRAVEL_TILT[step % 2]!;
  handle.char = char;
  handle.travelling = true;
};

/**
 * The landing flip — the only interpolated motion in the whole animation.
 *
 * The target glyph and pigment go into the *hidden* face, which is at
 * `rotateX(90deg)` and `opacity: 0`, so nothing about the new cell is visible
 * before it starts rotating in. Then both faces get the landing duration and swap
 * attitudes on one transition. Writing `transition-duration` and `transform` in
 * the same style change is what makes the transition run from the current
 * (cut, un-transitioned) position: the after-change duration is what governs.
 */
const land = (handle: TileHandle, char: string, color: BoardColor): void => {
  const incoming: 0 | 1 = handle.active === 0 ? 1 : 0;
  const inFace = handle.faces[incoming]!;
  const outFace = handle.faces[handle.active]!;

  paintFace(inFace, handle.glyphs[incoming]!, char, color);

  const duration = `${FLAP_LAND_MS}ms`;
  inFace.style.transitionDuration = duration;
  inFace.style.transform = FLAP_REST_TRANSFORM;
  inFace.style.opacity = "1";
  inFace.style.zIndex = "1";

  outFace.style.transitionDuration = duration;
  outFace.style.transform = FLAP_HIDDEN_TRANSFORM;
  outFace.style.opacity = "0";
  outFace.style.zIndex = "0";

  handle.active = incoming;
  handle.char = char;
  handle.color = color;
  handle.travelling = false;
};

/**
 * A tile that was mid-travel and whose new target is the glyph it is already
 * showing. It is sitting tipped with transitions off, so it has to be put back
 * flat — otherwise a retarget could leave a tile stranded at −34° forever.
 */
const settle = (handle: TileHandle): void => {
  const face = handle.faces[handle.active]!;
  face.style.transitionDuration = `${FLAP_LAND_MS}ms`;
  face.style.transform = FLAP_REST_TRANSFORM;
  handle.travelling = false;
};

/** The reduced-motion path, and the retarget-to-a-still-board path: no travel. */
const applyInstant = (
  handle: TileHandle,
  char: string,
  color: BoardColor
): void => {
  const face = handle.faces[handle.active]!;
  face.style.transitionDuration = "0ms";
  face.style.transform = FLAP_REST_TRANSFORM;
  face.style.opacity = "1";
  face.style.zIndex = "1";
  paintFace(face, handle.glyphs[handle.active]!, char, color);
  handle.char = char;
  handle.color = color;
  handle.travelling = false;
};

/**
 * Build the handle array once, in row-major order — which is document order,
 * because that is the order the tiles are rendered in. Seeded from the tile
 * root's own `data-char`/`data-color`, which at mount are exactly what the faces
 * were painted with.
 */
const collectHandles = (field: HTMLElement): TileHandle[] | null => {
  const tiles = field.querySelectorAll<HTMLElement>('[data-testid="flap-tile"]');
  if (tiles.length !== BOARD_ROWS * BOARD_COLS) return null;

  const handles: TileHandle[] = [];
  for (const tile of tiles) {
    const faces = tile.querySelectorAll<HTMLElement>(`[${FLAP_FACE_ATTR}]`);
    const glyphs = tile.querySelectorAll<HTMLElement>(`[${FLAP_GLYPH_ATTR}]`);
    const [face0, face1] = [faces[0], faces[1]];
    const [glyph0, glyph1] = [glyphs[0], glyphs[1]];
    if (
      face0 === undefined ||
      face1 === undefined ||
      glyph0 === undefined ||
      glyph1 === undefined
    ) {
      return null;
    }
    handles.push({
      faces: [face0, face1],
      glyphs: [glyph0, glyph1],
      active: 0,
      char: tile.dataset.char ?? " ",
      color: (tile.dataset.color ?? "black") as BoardColor,
      travelling: false,
    });
  }
  return handles;
};

/**
 * What the board is showing *right now*, as a grid. This — not the previous
 * React grid — is what a new plan is computed against, and it is the whole
 * mid-travel retarget story: a tile three glyphs into an `A → Z` run reports `D`,
 * so the new plan sends it forward from `D`. Nothing freezes, nothing jumps back
 * to a stale glyph, and a tile whose new target is behind it wraps rather than
 * reversing (which a real drum cannot do either).
 */
const displayedGrid = (handles: ReadonlyArray<TileHandle>): DisplayedGrid => ({
  rows: Array.from({ length: BOARD_ROWS }, (_, rowIndex) =>
    Array.from({ length: BOARD_COLS }, (_, colIndex): DisplayedCell => {
      const handle = handles[rowIndex * BOARD_COLS + colIndex]!;
      return { char: handle.char, color: handle.color };
    })
  ),
});

const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function useFlapAnimation(
  grid: BoardGrid,
  onMotion: ((movingCells: number) => void) | undefined
) {
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const handlesRef = useRef<TileHandle[] | null>(null);
  const schedulesRef = useRef<FlapSchedule[]>([]);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  /** `-1` so the very first report always writes the attribute, even if it is 0. */
  const movingRef = useRef(-1);
  /** `null` until the first grid has been seen — React already painted that one. */
  const seenRef = useRef<BoardGrid | null>(null);

  // The callback identity is allowed to change every render without restarting
  // anything; the loop reads it through the ref.
  const onMotionRef = useRef(onMotion);
  onMotionRef.current = onMotion;

  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;

    if (handlesRef.current === null) {
      handlesRef.current = collectHandles(field);
    }
    const handles = handlesRef.current;
    if (handles === null) return;

    /** Exposed so a test — or a human — can read the board's motion from the DOM. */
    const report = (moving: number, plan?: FlapTravelPlan): void => {
      if (plan !== undefined) {
        field.dataset.flapSteps = String(plan.steps);
        field.dataset.flapDuration = String(plan.durationMs);
      }
      if (movingRef.current !== moving) {
        movingRef.current = moving;
        field.dataset.flapMoving = String(moving);
      }
      onMotionRef.current?.(moving);
    };

    const stop = (): void => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      schedulesRef.current = [];
      startedAtRef.current = null;
    };

    const frame = (now: number): void => {
      rafRef.current = null;
      if (startedAtRef.current === null) startedAtRef.current = now;
      const elapsed = now - startedAtRef.current;
      // `+ 1` so the first flap is on screen on the very first frame: a board
      // that waits 72ms before moving reads as latency, not as mechanism.
      const due = Math.floor(elapsed / FLAP_STEP_MS) + 1;

      let moving = 0;
      for (const schedule of schedulesRef.current) {
        if (schedule.done) continue;
        const target = Math.min(schedule.steps, due);
        while (schedule.taken < target) {
          schedule.taken += 1;
          const char =
            schedule.sequence[schedule.taken - 1] ?? schedule.handle.char;
          if (schedule.taken === schedule.steps) {
            land(schedule.handle, char, schedule.toColor);
          } else {
            travelStep(schedule.handle, char, schedule.taken);
          }
        }
        if (schedule.taken >= schedule.steps) schedule.done = true;
        else moving += 1;
      }

      report(moving);
      if (moving > 0) rafRef.current = requestAnimationFrame(frame);
      else stop();
    };

    /** Snap the whole board to `next` with no travel and no sound. */
    const snapTo = (next: BoardGrid): void => {
      stop();
      next.rows.forEach((row, rowIndex) => {
        row.forEach((cell, colIndex) => {
          const handle = handles[rowIndex * BOARD_COLS + colIndex];
          if (handle === undefined) return;
          if (
            !handle.travelling &&
            handle.char === cell.char &&
            handle.color === cell.color
          ) {
            return;
          }
          applyInstant(handle, cell.char, cell.color);
        });
      });
      report(0);
    };

    // First run after mount: React has already rendered this grid into the
    // faces, so there is nothing to travel from. A page load is still and silent.
    // `report(0)` anyway, so `data-flap-moving` states "at rest" from mount
    // rather than being absent until the first change.
    if (seenRef.current === null) {
      seenRef.current = grid;
      report(0);
      return;
    }
    if (seenRef.current === grid) return;
    seenRef.current = grid;

    if (prefersReducedMotion()) {
      snapTo(grid);
      return;
    }

    // The plan is computed against what is *on screen*, so a grid arriving
    // mid-travel retargets every tile from wherever it actually is.
    const plan = travelPlan(displayedGrid(handles), grid);

    stop();

    const schedules: FlapSchedule[] = [];
    const planned = new Set<TileHandle>();
    for (const cell of plan.perCell) {
      const handle = handles[cell.row * BOARD_COLS + cell.col];
      if (handle === undefined) continue;
      planned.add(handle);
      // Travel is cut, not interpolated: kill the transition before the first
      // flap. A single-flap change skips this — it is nothing but a landing flip,
      // and it should look exactly as it always did.
      if (cell.steps > 1) {
        handle.faces[handle.active]!.style.transitionDuration = "0ms";
      }
      schedules.push({
        handle,
        sequence: cell.sequence,
        steps: cell.steps,
        toColor: cell.toColor,
        taken: 0,
        done: false,
      });
    }

    // Anything that was travelling and is no longer wanted anywhere has to be
    // put back flat rather than left tipped.
    for (const handle of handles) {
      if (handle.travelling && !planned.has(handle)) settle(handle);
    }

    schedulesRef.current = schedules;
    if (schedules.length === 0) {
      report(0, plan);
      return;
    }
    report(schedules.length, plan);
    rafRef.current = requestAnimationFrame(frame);
  }, [grid]);

  // Reduced motion can be turned on mid-travel (and on a TV, by an accessibility
  // preference sync). Stop dead and show the target.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => {
      if (!query.matches) return;
      const field = fieldRef.current;
      const handles = handlesRef.current;
      if (field === null || handles === null) return;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      schedulesRef.current = [];
      startedAtRef.current = null;
      const target = seenRef.current;
      if (target !== null) {
        target.rows.forEach((row, rowIndex) => {
          row.forEach((cell, colIndex) => {
            const handle = handles[rowIndex * BOARD_COLS + colIndex];
            if (handle !== undefined) applyInstant(handle, cell.char, cell.color);
          });
        });
      }
      movingRef.current = 0;
      field.dataset.flapMoving = "0";
      onMotionRef.current?.(0);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // A TV that navigates away mid-travel must not leave a loop running.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      schedulesRef.current = [];
    },
    []
  );

  return fieldRef;
}
