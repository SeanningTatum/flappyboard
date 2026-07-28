import {
  BLANK_COLOR,
  BOARD_ALIGNS,
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_COLOR,
  type BoardAlign,
  type BoardColor,
  type BoardMessage,
} from "@/lib/schemas/board";

/**
 * The editor's side of a **multi-segment** row: several coloured runs on one
 * board row, which is what makes `OSLO` white on the left and `12°` blue on the
 * right a single row rather than two.
 *
 * `BoardMessageRow.segments` has always been an array and `compileMessage` has
 * always handled it — the v1 editor simply only ever emitted one. So this module
 * is the missing conversion pair, and it is **not** in `message-io.ts` because
 * that module owns the v1 one-segment shape and the grid → message direction.
 *
 * One thing lives here that the compiler deliberately does not: **the
 * trailing-whitespace rule** (see `stripRowPadding`), which is where the
 * coloured-space trap is defused.
 *
 * `spread` used to live here too, resolved into a left-aligned row with
 * hand-computed white gaps before a `BoardMessage` existed. It doesn't any more:
 * layout is the compiler's job, an editor-only alignment was unreachable by the
 * LLM (which then padded rows by counting spaces, badly), and one layout
 * implementation is better than two. `align: "spread"` now travels all the way to
 * `compileMessage`.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Alignment is wholly a board concept now — these are `BoardAlign` verbatim,
 * re-exported under the editor's name because the editor renders one control per
 * value and its `data-testid`s are keyed on them.
 */
export const EDITOR_ALIGNS = BOARD_ALIGNS;
export type EditorAlign = BoardAlign;

export interface SegmentValues {
  readonly text: string;
  readonly color: BoardColor;
}

export interface RowValues {
  readonly align: EditorAlign;
  readonly segments: ReadonlyArray<SegmentValues>;
}

export interface LayoutValues {
  readonly rows: ReadonlyArray<RowValues>;
}

/**
 * The same shape with mutable arrays, which is what react-hook-form needs to
 * hand back out of `reset()`. Declared rather than derived so the editor's Effect
 * Schema form type and this stay structurally identical.
 */
export interface MutableRowValues {
  align: EditorAlign;
  segments: Array<{ text: string; color: BoardColor }>;
}

export interface MutableLayoutValues {
  rows: MutableRowValues[];
}

export const emptySegment = (): { text: string; color: BoardColor } => ({
  text: "",
  color: DEFAULT_COLOR,
});

/** One empty white segment, not zero: a row always has something to type into. */
export const emptyRow = (): MutableRowValues => ({
  align: "left",
  segments: [emptySegment()],
});

export const emptyLayout = (): MutableLayoutValues => ({
  rows: Array.from({ length: BOARD_ROWS }, emptyRow),
});

/* -------------------------------------------------------------------------- */
/* Editor rows → BoardMessage                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A pigment: a colour in which a space *can* be a lit tile. White and unlit are
 * the two in which it never is — the rule `compile.ts` calls `isSeparatorSpace`.
 */
const isPigmentColor = (color: BoardColor): boolean =>
  color !== DEFAULT_COLOR && color !== BLANK_COLOR;

const isAllSpaces = (text: string): boolean =>
  text.length > 0 && [...text].every((char) => char === " ");

/**
 * The coloured-space trap, defused.
 *
 * Trailing spaces a thumb typed by accident are padding, and padding is not
 * content: it shifts a `spread` row's value away from the right edge, and under
 * the *old* compiler rule it also lit up as a coloured bar nobody asked for. v1
 * dropped trailing whitespace from its single segment for that reason, and that
 * behaviour is preserved identically here.
 *
 * It is deliberately **not** applied per segment, which would be the obvious
 * generalisation and is wrong: an interior segment's trailing spaces are not
 * padding, they are the **gap** between two runs on the same row — the entire
 * weather layout. Stripping them would slide the right-hand segment back into the
 * left one. So only the row's **last** segment can hold padding.
 *
 * The one exception is a segment made **only** of spaces in a real pigment. That
 * is not padding, it is a solid colour bar, and it is also exactly what a per-cell
 * paint round-trips into (`cell-paint.ts` → `gridToMessage` → here): stripping it
 * would silently delete the tile the user just painted. An all-space *white*
 * segment has no such claim — it draws nothing either way — so it strips to
 * nothing and drops out, as it always has.
 *
 * `compile.ts` now lights a coloured space only in an all-space segment, so a
 * mixed segment like `"12°   "` in blue no longer holds lit tiles; its trailing
 * spaces are stripped here for the remaining reason — they are still *cells*, and
 * cells push a spread row's value off the right edge.
 */
const stripRowPadding = (
  segments: ReadonlyArray<SegmentValues>
): ReadonlyArray<SegmentValues> => {
  const kept = segments.filter((segment) => segment.text.length > 0);
  const last = kept[kept.length - 1];
  if (last === undefined) return kept;
  if (isPigmentColor(last.color) && isAllSpaces(last.text)) return kept;

  const text = last.text.replace(/\s+$/, "");
  if (text === last.text) return kept;
  if (text.length === 0) return kept.slice(0, -1);
  return [...kept.slice(0, -1), { text, color: last.color }];
};

/**
 * Editor rows → `BoardMessage`. Total, and the only writer of the multi-segment
 * shape on the phone.
 *
 * Alignment — `spread` included — passes straight through to the compiler, which
 * is the only place that knows how wide a normalised segment actually is. Leading
 * spaces are kept, exactly as v1 kept them: in white they are ordinary
 * indentation, in a colour they are a deliberate tile. Empty rows produce an
 * empty segment list rather than a segment holding `""`, because an empty
 * semantic row still occupies a board row.
 */
export const layoutToMessage = (values: LayoutValues): BoardMessage => ({
  rows: values.rows.slice(0, BOARD_ROWS).map((row) => ({
    align: row.align,
    segments: stripRowPadding(row.segments),
  })),
});

/* -------------------------------------------------------------------------- */
/* BoardMessage → editor rows                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The inverse, used when something outside the form authors the message: a paint
 * stroke (`cell-paint.ts`) writes its result straight back into the rows, so the
 * painted board stays editable as text instead of becoming a separate mode with
 * its own state that the text fields would then fight.
 *
 * `spread` survives the trip now that it is a real alignment, so an LLM-authored
 * label/value row lands in the editor still spread and its gaps re-flow as the user
 * retypes the value. A *painted* row is the exception: `cell-paint.ts` can only
 * express the alignments that read back out of a grid's edge padding, so painting a
 * spread row returns it as `left` with the gaps spelled out — an identical board,
 * one that no longer re-flows.
 */
export const messageToLayout = (message: BoardMessage): MutableLayoutValues => ({
  rows: Array.from({ length: BOARD_ROWS }, (_, index) => {
    const row = message.rows[index];
    if (row === undefined) return emptyRow();
    const segments = row.segments
      .slice(0, BOARD_COLS)
      .map((segment) => ({ text: segment.text, color: segment.color }));
    return {
      align: row.align,
      segments: segments.length === 0 ? [emptySegment()] : segments,
    };
  }),
});
