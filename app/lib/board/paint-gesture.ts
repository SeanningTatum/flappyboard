import type { CellEdit } from "@/lib/board/cell-paint";
import { BOARD_COLS, BOARD_ROWS, type BoardColor } from "@/lib/schemas/board";

/**
 * The three gestures the phone's grid understands, as data.
 *
 * `cell-paint.ts` already owns *what a paint does to a message*. What it does not
 * own is *what a finger means*: a tap is one cell, a drag is a run of cells in the
 * order they were touched, and a tap on a row handle is a whole row. Those three
 * translations are pure, they are the part most likely to be got subtly wrong (a
 * drag that re-adds a cell it already crossed, a row fill that is 23 cells long),
 * and they were previously inlined in the component where nothing could test them.
 *
 * A gesture is expressed as `ReadonlyArray<CellEdit>` and handed to `paintCells`
 * in **one** call. Never folded per cell: `paintCells` re-infers a row's alignment
 * once per call, so folding would let a row shift under the finger halfway along
 * its own stroke.
 */

/** A point on the grid, before a colour is attached to it. */
export interface CellRef {
  readonly row: number;
  readonly col: number;
}

/**
 * Append a cell to a stroke unless the stroke already crossed it.
 *
 * A drag reports the same cell many times — a finger sits inside one 13px column
 * for a dozen `pointermove` events, and a wobble re-enters cells it has left. The
 * duplicates are harmless to `paintCells` (the same cell painted twice is the same
 * cell painted once) but they make the stroke unbounded in length and the
 * in-flight highlight flicker, so they are dropped here.
 *
 * Order is preserved and the array identity is **reused when nothing changed**, so
 * a caller can use referential equality to skip a re-render.
 */
export const addStrokeCell = (
  stroke: ReadonlyArray<CellRef>,
  cell: CellRef
): ReadonlyArray<CellRef> =>
  stroke.some((seen) => seen.row === cell.row && seen.col === cell.col)
    ? stroke
    : [...stroke, cell];

/** A stroke, coloured. */
export const strokeEdits = (
  stroke: ReadonlyArray<CellRef>,
  color: BoardColor
): ReadonlyArray<CellEdit> =>
  stroke.map((cell) => ({ row: cell.row, col: cell.col, color }));

/**
 * A whole row, coloured — the gesture behind the row handles beside the grid.
 *
 * This is what makes the reference photo's purple top-and-bottom border two taps:
 * `rowEdits(0, "violet")` and `rowEdits(5, "violet")`. Out-of-range rows still
 * produce their edits rather than being filtered here; `paintCells` drops
 * unusable coordinates, and it is the one place that should decide what is on the
 * board.
 */
export const rowEdits = (
  row: number,
  color: BoardColor
): ReadonlyArray<CellEdit> =>
  Array.from({ length: BOARD_COLS }, (_, col) => ({ row, col, color }));

/**
 * A cell's coordinates read back off its DOM node's data attributes.
 *
 * The drag has to ask "which cell is under this point", and the answer comes from
 * `document.elementFromPoint`, which hands back an element rather than a React
 * callback. So the coordinates travel on the element as `data-row` / `data-col`,
 * and this is the parse — total, and rejecting anything that is not an in-range
 * integer pair so a stray `data-row="NaN"` cannot become row 0.
 */
export const parseCellRef = (
  row: string | undefined,
  col: string | undefined
): CellRef | null => {
  if (row === undefined || col === undefined) return null;
  if (row.trim() === "" || col.trim() === "") return null;
  const rowIndex = Number(row);
  const colIndex = Number(col);
  if (!Number.isInteger(rowIndex) || !Number.isInteger(colIndex)) return null;
  if (rowIndex < 0 || rowIndex >= BOARD_ROWS) return null;
  if (colIndex < 0 || colIndex >= BOARD_COLS) return null;
  return { row: rowIndex, col: colIndex };
};
