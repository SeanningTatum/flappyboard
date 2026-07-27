import {
  BLANK_COLOR,
  DEFAULT_COLOR,
  type BoardAlign,
  type BoardCell,
  type BoardColor,
  type BoardGrid,
  type BoardMessage,
  type BoardMessageRow,
} from "@/lib/schemas/board";

/**
 * The two conversions that sit either side of `compileMessage`:
 *
 * - **In**: what the phone's editor holds → a `BoardMessage` (`toBoardMessage`).
 * - **Out**: a stored grid → a `BoardMessage` that can be compiled again
 *   (`gridToMessage`), which is how the history strip re-flips something.
 *
 * They live here rather than inside the two components that use them because they
 * are pure, total and worth testing on their own — `gridToMessage` in particular
 * *infers* structure the grid does not record (colour runs, alignment), and that
 * inference is the kind of thing that quietly regresses.
 */

/* -------------------------------------------------------------------------- */
/* Editor values → BoardMessage                                               */
/* -------------------------------------------------------------------------- */

/**
 * One editor row. Declared structurally rather than imported from the editor's
 * Effect Schema form type so this module stays free of react-hook-form and the
 * component tree; the form's decoded type is assignable to it.
 */
export interface EditorRowValues {
  readonly text: string;
  readonly color: BoardColor;
  readonly align: BoardAlign;
}

export interface EditorValues {
  readonly rows: ReadonlyArray<EditorRowValues>;
}

/**
 * Editor rows → `BoardMessage`.
 *
 * The colour is attached to the *typed text* and to nothing else. This mattered
 * more when `compile.ts` lit every coloured space; it now lights only a segment
 * made *entirely* of spaces, so a row typed as `"HI"` in red and padded out to 24
 * characters would still become a red bar — the padding, stripped, is the whole
 * segment.
 *
 * So: trailing whitespace is dropped (it is padding by definition, and alignment
 * is the intended way to position a row), and no padding is emitted at all —
 * `compileMessage` pads with the unlit blank cell. Leading spaces are kept,
 * because they are ordinary indentation: in a one-segment row they now compile to
 * unlit cells whatever colour the row is, since a row with text in it is not an
 * all-space segment.
 */
export const toBoardMessage = (values: EditorValues): BoardMessage => ({
  rows: values.rows.map((row) => {
    const text = row.text.replace(/\s+$/, "");
    return {
      align: row.align,
      // An empty row still occupies a board row (see `compileRow`), so it is an
      // empty segment list rather than a segment holding "".
      segments: text.length === 0 ? [] : [{ text, color: row.color }],
    };
  }),
});

/* -------------------------------------------------------------------------- */
/* BoardGrid → BoardMessage                                                   */
/* -------------------------------------------------------------------------- */

/** A blank (unlit) cell: a space that carries no colour of its own. */
const isBlank = (cell: BoardCell): boolean =>
  cell.char === " " && cell.color === BLANK_COLOR;

/** A pigment: a colour in which a space is a tile rather than a separator. */
const isPigment = (color: BoardColor): boolean =>
  color !== DEFAULT_COLOR && color !== BLANK_COLOR;

/**
 * A grid row back into a semantic row — the best-effort inverse of `compileRow`.
 *
 * Two things have to be reconstructed. **Colour runs**: consecutive cells sharing
 * a colour collapse into one segment, and an unlit cell becomes a plain white
 * space so it stays a *separator* rather than becoming a lit white tile.
 *
 * One extra break, and it is what keeps the paint round trip exact. `compile.ts`
 * lights a coloured space only in a segment made *entirely* of spaces, so a run of
 * pigment cells that mixes glyphs and spaces — which is exactly what painting a
 * whole row of text produces — cannot be emitted as one segment: recompiled, its
 * interior spaces would go out. A pigment run is therefore split at every space
 * boundary, so `HI THERE` painted red comes back as `HI` / `" "` / `THERE`, all
 * red, and compiles to the identical grid. Separator-coloured runs (white, and the
 * unlit cells that map onto it) are *not* split, because a white space is a
 * separator either way and splitting them would spell out a spread row's gaps as
 * one segment per column.
 *
 * **Alignment**: the compiler expresses alignment as leading/trailing unlit
 * padding, and `wrapTokens` drops leading separator runs, so replaying the
 * padding verbatim would left-shift a centred row. The padding widths are read
 * back into an `align` instead: no leading pad → left, no trailing pad → right,
 * roughly symmetric → centre. A wildly asymmetric row (only reachable if a future
 * writer hand-builds a grid the compiler would not have produced) falls back to
 * left, losing its indentation — a re-flip is a convenience, not an archival
 * restore.
 */
const rowToMessageRow = (row: ReadonlyArray<BoardCell>): BoardMessageRow => {
  let start = 0;
  let end = row.length;
  while (start < end && isBlank(row[start]!)) start += 1;
  while (end > start && isBlank(row[end - 1]!)) end -= 1;

  const leading = start;
  const trailing = row.length - end;
  const align =
    leading === 0
      ? ("left" as const)
      : trailing === 0
        ? ("right" as const)
        : Math.abs(leading - trailing) <= 1
          ? ("center" as const)
          : ("left" as const);

  interface Run {
    text: string;
    color: BoardColor;
    /** Whether this run is made of spaces — only tracked for pigment runs. */
    space: boolean;
  }

  const runs: Array<Run> = [];
  for (let i = start; i < end; i += 1) {
    const cell = row[i]!;
    const color = isBlank(cell) ? DEFAULT_COLOR : cell.color;
    const space = cell.char === " ";
    const last = runs[runs.length - 1];
    if (
      last !== undefined &&
      last.color === color &&
      (!isPigment(color) || last.space === space)
    ) {
      last.text += cell.char;
    } else {
      runs.push({ text: cell.char, color, space });
    }
  }

  return {
    align,
    segments: runs.map(({ text, color }) => ({ text, color })),
  };
};

/** A stored grid back into a message the room can compile again. */
export const gridToMessage = (grid: BoardGrid): BoardMessage => ({
  rows: grid.rows.map(rowToMessageRow),
});
