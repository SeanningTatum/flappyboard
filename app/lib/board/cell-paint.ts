import { BLANK_CELL, compileMessage } from "@/lib/board/compile";
import { gridToMessage } from "@/lib/board/message-io";
import {
  BLANK_COLOR,
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_COLOR,
  type BoardAlign,
  type BoardCell,
  type BoardColor,
  type BoardMessage,
} from "@/lib/schemas/board";

/**
 * Per-cell colour, with **no schema change**.
 *
 * The request was "control each colour on each cell". `BoardMessage` has no cell
 * coordinates and is not getting any: it is the semantic layer, and the grid is a
 * *derived* artefact. So a paint is expressed as a round trip through the layer
 * that already exists —
 *
 *     message → compileMessage → grid → recolour one cell → gridToMessage → message
 *
 * — which means a painted board is still an ordinary `BoardMessage` that the room,
 * the socket, the history strip and the LLM all already understand, and the
 * colour runs the user painted come back as the segments `gridToMessage` infers.
 *
 * ## The one thing this layer cannot express
 *
 * `compile.ts` drops a **leading** separator run (`wrapTokens` skips a gap when
 * the line is still empty) and `trimTrailingBlanks` drops a trailing one. Unlit
 * tiles before the first lit tile of a row are therefore *only* expressible as
 * alignment padding, and alignment offers exactly three offsets: `0`,
 * `free`, `floor(free / 2)`.
 *
 * So when a paint changes where a row's leftmost lit cell sits — unlighting the
 * first character, or lighting a cell in the middle of an otherwise empty row —
 * the exact offset may simply not be sayable. `solveAlign` then keeps the
 * alignment the row already had, which means the row is re-laid out from that
 * alignment's own edge: a lone tile tapped into an empty left-aligned row appears
 * at column 0.
 *
 * That fallback is chosen for **stability**, not for landing nearest the finger.
 * Snapping to whichever of the three offsets is closest would move a tile one or
 * two columns instead of to the edge, but it also re-decides the alignment on
 * every tap, so a left-to-right run of taps drags the tiles already painted along
 * with it. Keeping the alignment means the leftmost lit cell moves **once**, and
 * every subsequent paint to the right of it is exact.
 *
 * Every other case — and that is nearly all of them: painting on top of text,
 * painting to the right of text, painting anywhere in a row that keeps its
 * leftmost cell, and any single stroke whose own extent happens to land on an
 * alignment offset — reproduces the painted grid **exactly**. Which is also why
 * `paintCells` takes a whole stroke: eight cells from column 8 are expressible as
 * one centred run even though tapping them one at a time is not.
 *
 * This is honest rather than hidden: the editor's preview runs the real
 * `compileMessage` on the result, so a row that had to move is visibly moved the
 * instant it is tapped, and the hint under the paint palette says so.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export interface CellEdit {
  /** 0-based, top to bottom. */
  readonly row: number;
  /** 0-based, left to right. */
  readonly col: number;
  readonly color: BoardColor;
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

const inRange = (edit: CellEdit): boolean =>
  Number.isInteger(edit.row) &&
  Number.isInteger(edit.col) &&
  edit.row >= 0 &&
  edit.row < BOARD_ROWS &&
  edit.col >= 0 &&
  edit.col < BOARD_COLS;

/** A blank (unlit) cell: a space carrying no colour of its own. */
const isBlank = (cell: BoardCell): boolean =>
  cell.char === " " && cell.color === BLANK_COLOR;

/**
 * Recolour one cell, keeping its character.
 *
 * Two cases are not a plain colour swap, and both follow from `black` being the
 * *unlit* tile rather than a pigment:
 *
 * - Painting `black` unlights the tile — character and all. A lit tile that kept
 *   its glyph in black would be a glyph nobody can read on a card that is off.
 * - Painting `white` onto a **space** also unlights it, because a white space *is*
 *   an unlit tile: `compileMessage` never emits `{ char: " ", color: "white" }`,
 *   it emits `BLANK_CELL`. Normalising here is what keeps the painted grid inside
 *   the set of grids the compiler can produce, and therefore what keeps the round
 *   trip exact.
 */
const repaint = (cell: BoardCell, color: BoardColor): BoardCell => {
  if (color === BLANK_COLOR) return BLANK_CELL;
  if (cell.char === " " && color === DEFAULT_COLOR) return BLANK_CELL;
  return { char: cell.char, color };
};

/* -------------------------------------------------------------------------- */
/* Alignment                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The alignments a paint can *express*. `spread` is absent because it does not
 * work by padding a row's edges — it decides the row's interior columns — so there
 * is no offset to read back out of a grid. A painted spread row therefore comes
 * back as a `left` row whose gaps are spelled out as segments, which compiles to
 * the identical grid (asserted in the round-trip tests); it simply stops re-flowing
 * on later edits, which is the same trade the paint layer already makes elsewhere.
 */
type PaintAlign = Exclude<BoardAlign, "spread">;

/** `padLine`'s rule, read the other way round. */
const padOffset = (align: PaintAlign, free: number): number =>
  align === "center" ? Math.floor(free / 2) : align === "right" ? free : 0;

const ALIGNMENTS: ReadonlyArray<PaintAlign> = ["left", "right", "center"];

/**
 * Which alignment reproduces this grid row's padding.
 *
 * `preferred` is tried first so a row that is *still* satisfiable by the
 * alignment it already had keeps it — otherwise a right-aligned row whose content
 * happens to fill the board would come back left-aligned and jump the next time
 * it was edited. The other two are then tried, because an offset that one of them
 * reproduces exactly is worth switching for: it is how a tile tapped into column
 * 23 of an empty row stays in column 23.
 *
 * Nothing exact, and the row keeps `preferred` — see the note at the top of this
 * file for why that beats the nearest offset. A row with no lit cells has no
 * padding to read, so it keeps `preferred` too.
 */
const solveAlign = (
  cells: ReadonlyArray<BoardCell>,
  preferred: PaintAlign
): PaintAlign => {
  let start = 0;
  let end = cells.length;
  while (start < end && isBlank(cells[start]!)) start += 1;
  while (end > start && isBlank(cells[end - 1]!)) end -= 1;
  if (start === end) return preferred;

  const free = cells.length - (end - start);
  for (const align of [preferred, ...ALIGNMENTS]) {
    if (padOffset(align, free) === start) return align;
  }
  return preferred;
};

/* -------------------------------------------------------------------------- */
/* Painting                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Recolour any number of cells at once — one gesture, one message.
 *
 * Batched rather than folded (`edits.reduce(paintCell, message)`) on purpose: a
 * fold would recompile and re-infer alignment between every cell of a drag, so a
 * stroke could shift a row under the finger halfway along. This applies the whole
 * stroke to one grid and recovers once.
 *
 * Out-of-range coordinates are dropped rather than thrown on — a paint is a
 * gesture, and a gesture off the edge of the board is a no-op. If *nothing* is in
 * range the original message is returned untouched, so a stray tap cannot even
 * re-normalise it.
 */
export const paintCells = (
  message: BoardMessage,
  edits: ReadonlyArray<CellEdit>
): BoardMessage => {
  const applicable = edits.filter(inRange);
  if (applicable.length === 0) return message;

  const before = compileMessage(message).grid;
  const after = before.rows.map((row) => [...row]);
  for (const edit of applicable) {
    const row = after[edit.row]!;
    row[edit.col] = repaint(row[edit.col]!, edit.color);
  }

  // `gridToMessage` recovers the colour runs; its alignment inference is a
  // heuristic built for re-flipping history, so the alignment is re-solved here
  // against the grid this paint actually intends.
  const recovered = gridToMessage({ rows: after });
  return {
    rows: recovered.rows.map((row, index) => ({
      ...row,
      align: solveAlign(after[index]!, solveAlign(before.rows[index]!, "left")),
    })),
  };
};

/** One cell. See `paintCells`. */
export const paintCell = (
  message: BoardMessage,
  edit: CellEdit
): BoardMessage => paintCells(message, [edit]);
