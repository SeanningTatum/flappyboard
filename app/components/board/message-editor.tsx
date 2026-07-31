import { useCallback, useMemo, useRef, useState } from "react";
import { useForm, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Schema } from "effect";
import { IconChevronDown, IconX } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { BoardGridView } from "@/components/board/board-grid-view";
import { effectResolver } from "@/lib/effect-form";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  CONSOLE,
  ConsoleLabel,
  EXTRUSION_FILL,
  EXTRUSION_LIP,
  FLAP_SURFACE_MINI,
  FlapSwatch,
  MASK_FILL,
  PLATE_LIP,
  SegmentTrack,
  TILE_PIGMENTS,
  WELL_LIP,
  segmentClass,
  segmentStyle,
} from "@/components/board/console";
import { BLANK_CELL, compileMessage } from "@/lib/board/compile";
import { paintCell, paintCells, type CellEdit } from "@/lib/board/cell-paint";
import {
  addStrokeCell,
  parseCellRef,
  rowEdits,
  strokeEdits,
  type CellRef,
} from "@/lib/board/paint-gesture";
import {
  EDITOR_ALIGNS,
  emptyLayout,
  emptySegment,
  layoutToMessage,
  messageToLayout,
} from "@/lib/board/segment-layout";
import {
  BOARD_COLORS,
  BOARD_COLS,
  BOARD_ROWS,
  BoardColor,
  MAX_SEGMENT_TEXT,
  type BoardCell,
  type BoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";

/**
 * The phone's message editor: six rows in, one board out.
 *
 * ## Type first, colour second
 *
 * The previous version put a text field, eight colour swatches, a four-way
 * alignment toggle and add/remove-segment keys **inside every one of six rows** —
 * about forty controls, all of them competing with the one thing a person picks
 * the phone up to do, which is type a sentence. This version splits the job into
 * two phases that share one grid:
 *
 * 1. **A plain typing surface.** Six bare wells, nothing in them but the row
 *    number and the caret. Enter advances to the next row, so a whole message is
 *    typed without the thumb leaving the keyboard.
 * 2. **The grid, directly below, as the colouring surface.** It already ran the
 *    real `compileMessage`; now it also takes paint — a tap, a drag, or a tap on a
 *    row's handle to fill the whole row. One shared palette, not six copies.
 *
 * The controls that did not survive contact with a 390px screen were not deleted,
 * they were **scoped to one row**: alignment (including `spread`), that row's own
 * colour, and its extra segments live on a single detail plate that follows the
 * focused row. Six copies of a control that only ever applies to one row at a time
 * is six times the panel for none of the reach.
 *
 * ## Why six inputs and not one six-line textarea
 *
 * A textarea is the smaller component and it was rejected. Row identity is
 * load-bearing here: row *n* of the editor is row *n* of the board, alignment is
 * per row, a row handle paints row *n*, and `MAX_SEGMENT_TEXT` is per row. In a
 * textarea all of that has to be recovered from `selectionStart`, and the two
 * kinds of line break — a newline the user typed and a soft wrap the browser
 * chose — are indistinguishable to the user and different to the parser. Six wells
 * make the mapping literal, keep the per-row `maxLength`, and keep the six
 * `control-row-input-*` handles a shipped verification already drives. The only
 * thing the textarea would have given for free is "Enter moves down", and that is
 * one keydown handler.
 *
 * ## Paint
 *
 * A tap recolours one cell, a drag recolours a stroke, a row handle recolours
 * twenty-four (`cell-paint.ts`). Every result is written **back into the form**, so
 * a painted board is still ordinary editable text and the multi-colour segments a
 * board ends up with are *derived from what was painted* rather than authored by
 * hand.
 *
 * The preview is not decoration. It runs the real `compileMessage`, so what the
 * user sees is the wrapping, the uppercasing, the dropped characters, the clipping
 * — and the alignment shift a paint sometimes has to make — before anything is
 * broadcast to a TV in someone else's living room.
 */

/* -------------------------------------------------------------------------- */
/* Form schema — Effect Schema, no Zod                                        */
/* -------------------------------------------------------------------------- */

/**
 * Every field is required with no schema-level default, so the decoded type and
 * the form's own value type are identical — react-hook-form never has to reason
 * about a field that is optional on the way in and present on the way out.
 */
const EditorSegment = Schema.mutable(
  Schema.Struct({
    text: Schema.String.pipe(Schema.maxLength(MAX_SEGMENT_TEXT)),
    color: BoardColor,
  })
);

const EditorRow = Schema.mutable(
  Schema.Struct({
    align: Schema.Literal(...EDITOR_ALIGNS),
    segments: Schema.mutable(
      Schema.Array(EditorSegment).pipe(
        Schema.minItems(1),
        Schema.maxItems(BOARD_COLS)
      )
    ),
  })
);

export const MessageEditorForm = Schema.mutable(
  Schema.Struct({
    rows: Schema.mutable(
      Schema.Array(EditorRow).pipe(Schema.itemsCount(BOARD_ROWS))
    ),
  })
);

export type MessageEditorValues = typeof MessageEditorForm.Type;

export const emptyEditorValues = (): MessageEditorValues => emptyLayout();

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

/** Trailing blanks trimmed per row so the text alternative isn't a wall of spaces. */
const gridToText = (grid: BoardGrid): string =>
  grid.rows
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .replace(/\s+$/, "")
    )
    .join("\n");

export interface BoardPreviewProps {
  readonly grid: BoardGrid;
  readonly className?: string;
  /**
   * Paint mode. When set, every cell is a button that reports its coordinates —
   * the miniature stops being a quotation of the board and becomes the canvas.
   */
  readonly onPaintCell?: (row: number, col: number) => void;
  /** A drag: the whole stroke in one message. Requires `onPaintCell`. */
  readonly onPaintStroke?: (cells: ReadonlyArray<CellRef>) => void;
  /** A tap on a row's handle: fill all `BOARD_COLS` cells of that row. */
  readonly onPaintRow?: (row: number) => void;
  /** Tint for cells the finger is currently over. */
  readonly paintColor?: BoardColor;
  readonly cellLabel?: (row: number, col: number, cell: BoardCell) => string;
  readonly rowLabel?: (row: number) => string;
  readonly disabled?: boolean;
}

// `font-flap`, like the real tile — this miniature quotes the board rather than
// referencing it, so it has to be set in the board's own face. See the note on
// `FACE_CLASS` in `flap-tile.tsx` for why the flap face is pinned separately
// from `--font-sans`.
const CELL_CLASS =
  "flex items-center justify-center overflow-hidden font-flap text-[min(3vw,0.7rem)] leading-none font-semibold";

/**
 * A 6×24 miniature — and the one place on this screen where the real board is
 * quoted rather than referenced.
 *
 * It was a black rectangle with a faint lattice, which is what you get when the
 * grid gaps are darker than the cells. The real object is the other way round:
 * the mask between two flaps is *lighter* than an unlit flap, because it is
 * painted aluminium and the flap is a card in a hole. So the mask fill and the
 * extrusion come straight from `board-frame.tsx`, the gaps show that mask
 * through, and every cell carries the flap's own seam. Down at 14px the seam is
 * the entire illusion: without it these are coloured squares.
 *
 * Still a static render, not `FlapTile` — `watch()` re-runs this on every
 * keystroke, and 144 tiles each starting a 220ms flip would be a phone-melting
 * way to preview a word. That is also why the surface gradient is the condensed
 * nine-stop `FLAP_SURFACE_MINI` and the notch is dropped: at this size the notch
 * is sub-pixel and costs 144 paints to not be seen.
 *
 * Sized entirely in percentages of its container, so it fits a 320px phone and a
 * tablet with no breakpoint and no resize listener.
 *
 * ## What paint mode changes about the object
 *
 * Two things, and both are deliberate departures from "quote the board exactly":
 *
 * - **The extrusion picks up an amber ring** — the console's one state signal.
 *   "This rectangle is now editable" has to be visible on the object itself, not
 *   only in the control that turned it on.
 * - **The rows get taller.** The quoted aspect ratio (`24 / 11`) reproduces the
 *   measured window proportions of the real unit, which puts a row pitch of about
 *   21px on a 390px phone — a target below every thumb guideline, and hopeless for
 *   a *drag*. In paint mode the ratio relaxes to `24 / 18`, which takes the row
 *   pitch to roughly 34px and the row handles with it. The flaps go slightly tall;
 *   the wrapping, colour, clipping and column positions the preview exists to
 *   predict are all unchanged, because none of them depends on cell height.
 *
 * A cell is still only ~13px wide, and there is no honest way around that: the
 * thing being addressed *is* one cell of a 24-column grid. What there is instead
 * is a way to avoid needing it — the row handle for a whole row, and a drag for a
 * run — so single-cell precision is the exception rather than the interaction.
 */
export function BoardPreview({
  grid,
  className,
  onPaintCell,
  onPaintStroke,
  onPaintRow,
  paintColor,
  cellLabel,
  rowLabel,
  disabled = false,
}: BoardPreviewProps) {
  const painting = onPaintCell !== undefined;

  /* ---------------------------------------------------------------------- */
  /* Drag                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * A stroke is collected on the *container*, and `document.elementFromPoint`
   * answers "which cell is under the finger now" — the cells' own handlers cannot,
   * because on touch every `pointermove` after a `pointerdown` is implicitly
   * captured to the element the finger started on. That implicit capture is also
   * what makes this work without `setPointerCapture`, which is deliberately **not**
   * used: an explicit capture retargets the compatibility mouse events too, so the
   * `click` that ends a tap would be delivered to this container instead of to the
   * cell — and the tap path would stop working.
   *
   * The single-tap path is left alone for the same reason. A one-cell stroke is
   * *not* committed here; the cell's own `onClick` handles it, exactly as before,
   * so every documented single-tap behaviour (`cell-paint.ts`'s alignment
   * anchoring, and the tests that pin it) is untouched by adding the drag. Only a
   * stroke that really moved is batched, and it then swallows the click that
   * follows it.
   */
  const dragging = useRef(false);
  const swallowClick = useRef(false);
  /**
   * The stroke is state rather than a ref because the cells under the finger are
   * *drawn* as they are collected — a stroke you cannot see until you let go is a
   * stroke you cannot aim. `addStrokeCell` returns the same array when the cell was
   * already crossed, so the dozen `pointermove` events fired inside one 13px
   * column cost exactly one render between them.
   */
  const [stroke, setStroke] = useState<ReadonlyArray<CellRef>>([]);
  const collected = useRef<ReadonlyArray<CellRef>>([]);

  const collect = useCallback((clientX: number, clientY: number) => {
    const target = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLElement>("[data-cell]");
    const cell = parseCellRef(target?.dataset.row, target?.dataset.col);
    if (cell === null) return;
    const next = addStrokeCell(collected.current, cell);
    if (next === collected.current) return;
    collected.current = next;
    setStroke(next);
  }, []);

  const strokeSupported = painting && onPaintStroke !== undefined && !disabled;

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!strokeSupported) return;
      dragging.current = true;
      collected.current = [];
      // Cleared here rather than when it is consumed: a mouse drag that starts on
      // one cell and ends on another delivers its `click` to this container, so
      // nothing would ever consume the flag and the *next* tap would be eaten.
      swallowClick.current = false;
      collect(event.clientX, event.clientY);
    },
    [collect, strokeSupported]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      collect(event.clientX, event.clientY);
    },
    [collect]
  );

  const endStroke = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const cells = collected.current;
    collected.current = [];
    setStroke([]);
    // One cell is a tap: let the button's own click do it, so the tap path keeps
    // its existing semantics exactly.
    if (cells.length < 2) return;
    swallowClick.current = true;
    onPaintStroke?.(cells);
  }, [onPaintStroke]);

  /** Membership by identity of the collected refs — six rows of 24 is 144 checks. */
  const inStroke = useCallback(
    (row: number, col: number) =>
      stroke.some((cell) => cell.row === row && cell.col === col),
    [stroke]
  );

  return (
    <div
      className={cn("w-full", className)}
      data-testid="control-preview"
      // Interactive children under `role="img"` would be a lie to a screen
      // reader, so the role changes with the mode. The text alternative stays
      // either way: it is the only textual form of the board on this screen.
      role={painting ? "group" : "img"}
      aria-label={gridToText(grid)}
      data-painting={painting ? "true" : undefined}
    >
      {/* The extrusion: ~2px of aluminium, lit on top, lost underneath. */}
      <div
        style={{
          padding: "2px",
          backgroundColor: EXTRUSION_FILL,
          boxShadow: painting
            ? `${EXTRUSION_LIP}, 0 0 0 2px ${CONSOLE.amber}`
            : EXTRUSION_LIP,
        }}
      >
        {/*
          The mask. Set behind the lip so the lip shades its edges, with one
          hairline where they meet — which is the only reason the lip reads as a
          separate piece of metal rather than as a border.
        */}
        <div
          className="px-1 pt-1 pb-2.5"
          style={{
            backgroundColor: "#2a2a2b",
            backgroundImage: MASK_FILL,
            boxShadow:
              "inset 0 0 0 1px rgba(0,0,0,0.55), inset 0 2px 5px rgba(0,0,0,0.5)",
          }}
        >
          <div className="flex items-stretch gap-1">
            {/*
              The row handles: six keys cut into the left of the bezel, one per
              board row, each aligned to its row's pitch because it shares the
              grid definition. This is what makes the reference photo's purple
              top-and-bottom border **two taps** instead of forty-eight.

              Only in paint mode — outside it the board is a quotation and gets no
              furniture of its own.
            */}
            {painting && onPaintRow !== undefined && (
              <div
                className="grid w-9 shrink-0"
                style={{
                  gridTemplateRows: `repeat(${BOARD_ROWS}, minmax(0, 1fr))`,
                  rowGap: "7px",
                }}
                role="group"
              >
                {grid.rows.map((_row, rowIndex) => (
                  <button
                    key={rowIndex}
                    type="button"
                    className="flex touch-manipulation items-center justify-center font-mono text-[11px] leading-none disabled:opacity-40"
                    style={{
                      color: CONSOLE.inkDim,
                      backgroundColor: CONSOLE.panel,
                      boxShadow: PLATE_LIP,
                    }}
                    onClick={() => onPaintRow(rowIndex)}
                    disabled={disabled}
                    aria-label={rowLabel?.(rowIndex)}
                    data-testid={`control-preview-row-${rowIndex}`}
                  >
                    {rowIndex + 1}
                  </button>
                ))}
              </div>
            )}

            {/*
              The gaps are the mask, and the mask is **not** square. Measured, a
              real window is 61 × 97px on a 68 × 140px pitch: 10% of the column
              pitch goes to mask, but 31% of the row pitch does. An equal gap in
              both axes was the reason the first pass read as one dark field with a
              faint grid — the rows had no mask band between them, so there were no
              rows.
            */}
            <div
              className="grid min-w-0 flex-1"
              style={{
                gridTemplateColumns: `repeat(${BOARD_COLS}, minmax(0, 1fr))`,
                gridTemplateRows: `repeat(${BOARD_ROWS}, minmax(0, 1fr))`,
                columnGap: "2px",
                rowGap: "7px",
                // Chosen so a ~340px-wide phone lands on the measured 0.61 window
                // ratio. Relaxed in paint mode so a row is thumb-sized — see the
                // note on this component.
                aspectRatio: painting
                  ? `${BOARD_COLS} / 18`
                  : `${BOARD_COLS} / 11`,
                // A stroke must not also scroll the page. Only while painting:
                // outside it, a drag over the preview is an ordinary scroll.
                touchAction: strokeSupported ? "none" : undefined,
              }}
              onPointerDown={strokeSupported ? onPointerDown : undefined}
              onPointerMove={strokeSupported ? onPointerMove : undefined}
              onPointerUp={strokeSupported ? endStroke : undefined}
              onPointerCancel={strokeSupported ? endStroke : undefined}
              // A mouse dragged off the grid never reports its release here, so
              // the stroke would hang open. Touch cannot reach this (implicit
              // capture keeps its events coming), and it costs nothing.
              onPointerLeave={strokeSupported ? endStroke : undefined}
            >
              {grid.rows.map((row, rowIndex) =>
                row.map((cell, colIndex) => {
                  const key = `${rowIndex}-${colIndex}`;
                  // A cell under the finger shows the colour it is about to
                  // become, so a stroke is visible while it is being drawn
                  // rather than only after it lands.
                  const wet =
                    paintColor !== undefined && inStroke(rowIndex, colIndex);
                  const pigment = TILE_PIGMENTS[wet ? paintColor : cell.color];
                  const style = {
                    borderRadius: "1px",
                    backgroundColor: pigment.fill,
                    backgroundImage: FLAP_SURFACE_MINI,
                    color: pigment.ink,
                  };
                  /*
                    The same 0.85 horizontal squeeze the real tile uses. Inter has
                    no condensed cut and `font-stretch` does nothing to a static
                    face, so this is how the glyphs stay the tighter industrial
                    width they have on the board.
                  */
                  const glyph = (
                    <span
                      className="block"
                      style={{ transform: "scaleX(0.85)" }}
                    >
                      {cell.char === " " ? "" : cell.char}
                    </span>
                  );

                  if (!painting) {
                    return (
                      <span key={key} className={CELL_CLASS} style={style}>
                        {glyph}
                      </span>
                    );
                  }

                  return (
                    <button
                      key={key}
                      type="button"
                      // `touch-action: manipulation` removes the 300ms
                      // double-tap delay so a run of taps lands as a run.
                      className={cn(CELL_CLASS, "touch-manipulation")}
                      style={style}
                      onClick={() => {
                        // A drag ends in a click on whichever cell the finger
                        // left; the stroke already covered it.
                        if (swallowClick.current) {
                          swallowClick.current = false;
                          return;
                        }
                        onPaintCell(rowIndex, colIndex);
                      }}
                      disabled={disabled}
                      aria-label={cellLabel?.(rowIndex, colIndex, cell)}
                      data-testid={`control-preview-cell-${rowIndex}-${colIndex}`}
                      data-color={cell.color}
                      data-cell=""
                      data-row={rowIndex}
                      data-col={colIndex}
                    >
                      {glyph}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/*
            Etched into the bottom bezel, exactly where the real unit puts it.
            Engraving, not printing: a dark cut with the light sitting on the
            cut's lower edge. Decorative and duplicated by the grid's own text
            alternative, so it is hidden from the accessibility tree.
          */}
          <span
            aria-hidden
            className="mt-1.5 block text-center text-[6px] leading-none font-medium uppercase"
            style={{
              letterSpacing: "0.38em",
              // Tracking lands on the right of the last glyph too, so the string
              // is optically centred only with half of it given back.
              marginLeft: "0.25em",
              color: "rgba(0,0,0,0.55)",
              textShadow: "0 0.5px 0 rgba(255,255,255,0.1)",
            }}
          >
            Flappyboard
          </span>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The typing surface                                                         */
/* -------------------------------------------------------------------------- */

interface RowWellProps {
  readonly form: UseFormReturn<MessageEditorValues>;
  readonly index: number;
  readonly active: boolean;
  /** How many coloured runs this row has. More than one and the well says so. */
  readonly segments: number;
  readonly pending: boolean;
  /** Paint mode: the rows are being written by taps, so they stop taking type. */
  readonly locked: boolean;
  readonly onFocus: () => void;
  readonly onEnter: () => void;
}

/**
 * One row of the message: a numbered well and nothing else.
 *
 * The row number is engraved into the left of the well rather than parked outside
 * it — the label belongs to the slot, and it buys back 28px of typing width. The
 * focused row carries a hairline of off-white down its left edge, which is the
 * only thing on the plate that says "the detail below belongs to this row".
 */
function RowWell({
  form,
  index,
  active,
  segments,
  pending,
  locked,
  onFocus,
  onEnter,
}: RowWellProps) {
  const { t } = useTranslation("board");

  return (
    <FormField
      control={form.control}
      name={`rows.${index}.segments.0.text`}
      render={({ field }) => (
        <FormItem
          className="relative gap-0"
          data-testid={`control-row-${index}`}
          data-active={active ? "true" : undefined}
        >
          <FormLabel
            className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 flex w-7 shrink-0 items-center justify-center font-mono text-[11px]"
            style={{ color: active ? CONSOLE.ink : CONSOLE.inkMute }}
          >
            {index + 1}
          </FormLabel>
          <FormControl>
            <Input
              // No autocorrect/autocapitalise: the board uppercases and folds
              // everything itself, and a phone keyboard "fixing" a deliberately
              // odd message is a bug, not a feature.
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
              // Six wells, and Enter walks down them — which is the whole reason
              // a textarea was not needed. The last row says "done" because
              // there is nowhere left to go.
              enterKeyHint={index === BOARD_ROWS - 1 ? "done" : "next"}
              maxLength={MAX_SEGMENT_TEXT}
              placeholder={t("control.editor.row_placeholder", {
                number: index + 1,
              })}
              // 44px minimum: a thumb target, not a mouse target. A well, not a
              // card: recessed, near-square corners, and the caret sits at the
              // bottom of a hole.
              className={cn(
                "h-11 rounded-[2px] border-0 py-0 pl-7 font-mono text-base tracking-wide uppercase shadow-none",
                segments > 1 ? "pr-10" : "pr-3",
                // An empty row's placeholder must read as an empty slot, not as
                // content: six bright "ROW 3" strings look like a board that
                // already says something.
                "placeholder:text-[#5a5a5c] focus-visible:ring-0 dark:bg-transparent"
              )}
              style={{
                backgroundColor: CONSOLE.well,
                boxShadow: active
                  ? `${WELL_LIP}, inset 2px 0 0 ${CONSOLE.ink}`
                  : WELL_LIP,
                color: locked ? CONSOLE.inkDim : CONSOLE.ink,
              }}
              data-testid={`control-row-input-${index}`}
              {...field}
              onFocus={onFocus}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                // Not a submit. Enter on row 3 of 6 means "next line", and a
                // board that sent itself halfway through being written would be
                // the single most annoying thing this screen could do.
                event.preventDefault();
                onEnter();
              }}
              readOnly={locked}
              disabled={pending}
            />
          </FormControl>

          {/*
            A row that has been painted comes back as several coloured runs, and
            this well only ever holds the **first** one — so without this badge the
            well would say `HAPPY` under a board that says `HAPPY FRIDAY` and there
            would be nothing on screen to explain the difference. The count is the
            explanation, and the rest of the runs are on the detail plate for
            whichever row is focused.
          */}
          {segments > 1 && (
            <span
              aria-hidden
              className="pointer-events-none absolute top-0 right-0 bottom-0 flex w-9 items-center justify-center font-mono text-[11px]"
              style={{ color: CONSOLE.inkMute }}
            >
              {`·${segments}`}
            </span>
          )}
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* One colour strip                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Testids are **stable across every restructure so far**: a row's first segment
 * keeps the flat names a shipped verification already drives
 * (`control-row-input-0`, `control-row-0-color-red`, `control-row-0-color-name`),
 * and only the segments that did not exist in v1 take the indexed form. One
 * exception to one rule beats renaming what already works.
 */
const segmentTestId = (row: number, segment: number, part: string): string =>
  segment === 0
    ? part === "input"
      ? `control-row-input-${row}`
      : `control-row-${row}-${part}`
    : `control-row-${row}-segment-${segment}-${part}`;

interface ColorStripProps {
  readonly form: UseFormReturn<MessageEditorValues>;
  readonly rowIndex: number;
  readonly segmentIndex: number;
  readonly color: BoardColor;
  readonly pending: boolean;
}

/**
 * Eight windows in a strip, one tap each, no hover and no `<select>` — laid out
 * as a single row because that is what the board's own colour row looks like.
 *
 * Still worth its space next to paint: "make this line red" is one tap here and
 * twenty-four on the grid.
 */
function ColorStrip({
  form,
  rowIndex,
  segmentIndex,
  color,
  pending,
}: ColorStripProps) {
  const { t } = useTranslation("board");
  const first = segmentIndex === 0;

  return (
    <div className="flex items-center gap-2">
      <div
        className="flex min-w-0 flex-1 items-stretch gap-1"
        role="radiogroup"
        aria-label={
          first
            ? t("control.editor.color_label")
            : t("control.editor.segment_color_label", {
                number: segmentIndex + 1,
              })
        }
      >
        {BOARD_COLORS.map((swatch) => {
          const active = color === swatch;
          return (
            <button
              key={swatch}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={t(`control.colors.${swatch}`)}
              title={t(`control.colors.${swatch}`)}
              disabled={pending}
              onClick={() =>
                form.setValue(
                  `rows.${rowIndex}.segments.${segmentIndex}.color`,
                  swatch,
                  { shouldDirty: true }
                )
              }
              // Full height is the touch target; the window inside it is smaller
              // than the target, as a key on a real panel is smaller than the
              // finger.
              className="flex h-11 min-w-0 flex-1 basis-0 items-center justify-center disabled:opacity-40"
              data-testid={segmentTestId(
                rowIndex,
                segmentIndex,
                `color-${swatch}`
              )}
            >
              <FlapSwatch color={swatch} active={active} />
            </button>
          );
        })}
      </div>

      {/*
        The selected pigment, spelled out. Second signal for the two dark chips:
        "White" and "Unlit" are the same fill on this board, so the strip shows
        the difference and this names it. Beside the strip rather than under it —
        one line of chrome instead of two, on a plate that is deliberately small.
      */}
      <span
        className="w-14 shrink-0 truncate text-right text-[10px] font-medium uppercase"
        style={{ color: CONSOLE.inkDim, letterSpacing: "0.1em" }}
        data-testid={segmentTestId(rowIndex, segmentIndex, "color-name")}
      >
        {t(`control.colors.${color}`)}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The focused row's detail plate                                             */
/* -------------------------------------------------------------------------- */

interface RowDetailProps {
  readonly form: UseFormReturn<MessageEditorValues>;
  readonly index: number;
  readonly row: MessageEditorValues["rows"][number];
  readonly pending: boolean;
  readonly locked: boolean;
}

/**
 * Everything that used to be repeated six times, for **one** row: where the row
 * sits, what colour it prints in, and the extra segments a `spread` row needs.
 *
 * Scoped to the focused row rather than collapsed behind a disclosure, because a
 * disclosure is a thing to discover and a thing to close. Focus already says
 * which row is being worked on — the caret is in it — so this plate simply
 * follows the caret. Tapping a row's well is therefore also how its alignment
 * gets reached, which is one gesture fewer than any accordion.
 *
 * `spread` needs two segments to mean anything (`RAIN` … `30%`), so `+ Colour` is
 * here and always visible. It is not the default surface: a person typing a
 * sentence never opens it, and a person painting never needs it, because
 * `gridToMessage` derives the segments from the paint.
 */
function RowDetail({ form, index, row, pending, locked }: RowDetailProps) {
  const { t } = useTranslation("board");
  const segments = row.segments.length > 0 ? row.segments : [emptySegment()];

  const setSegments = (
    next: ReadonlyArray<{ text: string; color: BoardColor }>
  ) =>
    form.setValue(`rows.${index}.segments`, [...next], { shouldDirty: true });

  return (
    <div
      className="flex flex-col gap-2 rounded-none p-2"
      style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
      data-testid="control-row-detail"
      data-row={index}
    >
      {/*
        The plate's own header line carries the rare action rather than giving it
        a row of its own: `+ Colour` is how a `spread` row gets its second
        segment, and it is used once in twenty sessions.
      */}
      <div className="flex items-center justify-between gap-2">
        <ConsoleLabel>
          {t("control.editor.row_detail", { number: index + 1 })}
        </ConsoleLabel>
        <button
          type="button"
          // 44px, like every other target on this screen. It was 32.
          className="h-11 shrink-0 touch-manipulation rounded-none px-3 text-[10px] font-medium uppercase disabled:opacity-40"
          style={{
            color: CONSOLE.inkDim,
            letterSpacing: "0.14em",
            boxShadow: `inset 0 0 0 1px ${CONSOLE.hairline}`,
          }}
          disabled={pending || segments.length >= BOARD_COLS}
          onClick={() => setSegments([...segments, emptySegment()])}
          data-testid={`control-row-${index}-add-segment`}
        >
          {t("control.editor.add_segment")}
        </button>
      </div>

      <SegmentTrack role="radiogroup" aria-label={t("control.editor.align_label")}>
        {EDITOR_ALIGNS.map((align) => {
          const active = row.align === align;
          return (
            <button
              key={align}
              type="button"
              disabled={pending}
              className={cn(
                segmentClass(active),
                // 44px: four alignment keys share one track, so each is already
                // narrow — losing height as well put them at 36.
                "h-11 min-w-0 flex-1 basis-0 touch-manipulation px-0.5"
              )}
              style={segmentStyle(active)}
              onClick={() =>
                form.setValue(`rows.${index}.align`, align, {
                  shouldDirty: true,
                })
              }
              aria-pressed={active}
              data-testid={`control-row-${index}-align-${align}`}
            >
              {t(`control.editor.align.${align}`)}
            </button>
          );
        })}
      </SegmentTrack>

      {segments.map((segment, segmentIndex) => (
        <div
          key={segmentIndex}
          className="flex flex-col gap-2"
          data-testid={`control-row-${index}-segment-${segmentIndex}`}
        >
          {/*
            Segment 0's text is the well up in the typing surface — repeating it
            here would put two inputs on one testid and two carets on one string.
            Later segments have nowhere else to live, so they bring their own.
          */}
          {segmentIndex > 0 && (
            <div className="flex items-center gap-1">
              <FormField
                control={form.control}
                name={`rows.${index}.segments.${segmentIndex}.text`}
                render={({ field }) => (
                  <FormItem className="relative min-w-0 flex-1 gap-0">
                    <FormLabel
                      className="pointer-events-none absolute top-0 bottom-0 left-0 z-10 flex w-7 shrink-0 items-center justify-center font-mono text-[11px]"
                      style={{ color: CONSOLE.inkMute }}
                    >
                      {`·${segmentIndex + 1}`}
                    </FormLabel>
                    <FormControl>
                      <Input
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        inputMode="text"
                        enterKeyHint="done"
                        maxLength={MAX_SEGMENT_TEXT}
                        placeholder={t("control.editor.segment_placeholder")}
                        className={cn(
                          "h-11 rounded-[2px] border-0 py-0 pr-3 pl-7 font-mono text-base tracking-wide uppercase shadow-none",
                          "focus-visible:ring-0 dark:bg-transparent"
                        )}
                        style={{
                          backgroundColor: CONSOLE.well,
                          boxShadow: WELL_LIP,
                          color: locked ? CONSOLE.inkDim : CONSOLE.ink,
                        }}
                        data-testid={segmentTestId(index, segmentIndex, "input")}
                        {...field}
                        readOnly={locked}
                        disabled={pending}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <button
                type="button"
                className="flex h-11 w-9 shrink-0 items-center justify-center rounded-none disabled:opacity-40"
                style={{
                  color: CONSOLE.inkMute,
                  boxShadow: `inset 0 0 0 1px ${CONSOLE.hairline}`,
                }}
                onClick={() =>
                  setSegments(segments.filter((_, i) => i !== segmentIndex))
                }
                disabled={pending}
                aria-label={t("control.editor.remove_segment", {
                  number: segmentIndex + 1,
                })}
                data-testid={`control-row-${index}-remove-segment-${segmentIndex}`}
              >
                <IconX className="size-3.5" aria-hidden />
              </button>
            </div>
          )}

          <ColorStrip
            form={form}
            rowIndex={index}
            segmentIndex={segmentIndex}
            color={segment.color}
            pending={pending}
          />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editor                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The colour a tap paints with. `red` rather than `white`, because a white space
 * *is* an unlit tile (see `cell-paint.ts`): a palette that started on white would
 * open with the one pigment that does nothing to an empty cell.
 */
const DEFAULT_PAINT_COLOR = "red" as const satisfies BoardColor;

/**
 * Whether a compiled grid says nothing at all — every cell blank, no paint.
 *
 * Drives the one-instrument swap below. Deliberately not `formState.isDirty`:
 * painting writes its result back through `form.reset`, which clears RHF's dirty
 * flag, so a fully painted board would have reported itself untouched.
 */
const gridIsBlank = (grid: BoardGrid): boolean =>
  grid.rows.every((row) =>
    row.every(
      (cell) =>
        cell.char === BLANK_CELL.char && cell.color === BLANK_CELL.color
    )
  );

export interface MessageEditorProps {
  /**
   * The board as it is on the wall right now, straight off the controller's
   * socket. Shown in the instrument whenever there is no draft — see the swap
   * at the render site.
   */
  readonly liveGrid: BoardGrid;
  readonly onSend: (message: BoardMessage) => void;
  readonly pending: boolean;
}

export function MessageEditor({
  liveGrid,
  onSend,
  pending,
}: MessageEditorProps) {
  const { t } = useTranslation("board");

  const form = useForm<MessageEditorValues>({
    resolver: effectResolver(MessageEditorForm),
    defaultValues: emptyEditorValues(),
    mode: "onChange",
  });

  const [painting, setPainting] = useState(false);
  const [paintColor, setPaintColor] = useState<BoardColor>(DEFAULT_PAINT_COLOR);
  /** Whether the six typing wells are showing. See the note at the disclosure. */
  const [rowsOpen, setRowsOpen] = useState(true);
  /** Which row the detail plate is describing. Row 1 until a caret says otherwise. */
  const [activeRow, setActiveRow] = useState(0);

  // `watch()` (not `getValues()`) so the preview re-renders as the thumb types —
  // that is the whole point of showing it.
  const values = form.watch();

  const compiled = useMemo(
    () => compileMessage(layoutToMessage(values)),
    [values]
  );

  /**
   * A paint's result goes **back into the form**, so the rows above always
   * describe the board exactly. The alternative — holding a painted message
   * beside the form — would give this screen two sources of truth and the text
   * fields would silently discard every paint.
   *
   * The round trip is grid-stable (`segment-layout.test.ts`), so a run of taps or
   * strokes accumulates instead of drifting.
   */
  const applyEdits = useCallback(
    (edits: ReadonlyArray<CellEdit>) => {
      const next = paintCells(layoutToMessage(form.getValues()), edits);
      form.reset(messageToLayout(next), { keepDefaultValues: true });
    },
    [form]
  );

  const paint = useCallback(
    (row: number, col: number) => {
      // One tap goes through `paintCell`, not `paintCells`, so the single-cell
      // path is byte-identical to the one the tests pin.
      const next = paintCell(layoutToMessage(form.getValues()), {
        row,
        col,
        color: paintColor,
      });
      form.reset(messageToLayout(next), { keepDefaultValues: true });
    },
    [form, paintColor]
  );

  const paintStroke = useCallback(
    (cells: ReadonlyArray<CellRef>) => applyEdits(strokeEdits(cells, paintColor)),
    [applyEdits, paintColor]
  );

  /**
   * A whole row in one tap. Twenty-four edits in **one** `paintCells` call, not
   * twenty-four folded ones: a fold would re-infer the row's alignment between
   * every cell and could shift the row halfway along its own fill.
   */
  const paintRow = useCallback(
    (row: number) => applyEdits(rowEdits(row, paintColor)),
    [applyEdits, paintColor]
  );

  const cellLabel = useCallback(
    (row: number, col: number, cell: BoardCell) =>
      t("control.paint.cell", {
        row: row + 1,
        col: col + 1,
        color: t(`control.colors.${cell.color}`),
      }),
    [t]
  );

  const rowLabel = useCallback(
    (row: number) =>
      t("control.paint.row", {
        row: row + 1,
        color: t(`control.colors.${paintColor}`),
      }),
    [paintColor, t]
  );

  /** Enter walks down the wells. The last row has nowhere to go, so it blurs. */
  const focusRow = useCallback((index: number) => {
    const next = document.querySelector<HTMLInputElement>(
      `[data-testid="control-row-input-${index}"]`
    );
    next?.focus();
  }, []);

  const activeRowValues = values.rows[activeRow] ?? values.rows[0];

  /**
   * Which board the instrument is showing. Paint forces the draft even on an
   * empty form — arming paint with nothing composed has to give the finger a
   * canvas, not the wall's current message with taps that go nowhere.
   */
  const showingLive = !painting && gridIsBlank(compiled.grid);

  return (
    <Form {...form}>
      {/*
        `method="post"` for the same reason as the auth forms: before hydration a
        <form> defaults to GET, which would put the message in the URL.
      */}
      <form
        method="post"
        onSubmit={form.handleSubmit((data) => onSend(layoutToMessage(data)))}
        className="flex flex-col gap-4"
        data-testid="control-editor"
      >
        {/*
          THE INSTRUMENT — first on the screen, and the same rectangle whether it
          is reporting or receiving.

          It used to sit *under* six text wells as a preview of them, with the
          live board rendered again as a separate section above. That was two
          boards a hand's width apart on a 390px phone and a preview that only
          existed once you had already typed. Now there is one grid in one place:

          - **Nothing composed** → the live board off the socket, animated, flaps
            actually travelling. "What does it say right now" is answered before
            anybody asks.
          - **Something composed, or paint armed** → the compiled draft, which is
            also the canvas paint lands on.

          The swap is on `gridIsBlank(compiled.grid)`, so clearing the form hands
          the screen back to the live board with no extra control to press.
        */}
        <section className="flex flex-col gap-2">
          {/*
            The label, the lamp and the mode key on **one** line. The key had a
            line of its own for a while and it read as a section of the panel
            rather than as a switch on the board's own caption — and it cost 40px
            of the thing it was captioning.
          */}
          <div className="flex items-center justify-between gap-2">
            <ConsoleLabel>
              {showingLive ? t("control.mirror.title") : t("control.preview.title")}
            </ConsoleLabel>
            {compiled.truncated && (
              <span
                className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase"
                style={{ color: CONSOLE.amber, letterSpacing: "0.14em" }}
                data-testid="control-preview-truncated"
              >
                {/*
                  An indicator lamp, square — a round dot would join the board's
                  own lattice of holes and read as one more tile.
                */}
                <span
                  aria-hidden
                  className="size-1.5 shrink-0"
                  style={{ backgroundColor: CONSOLE.amber }}
                />
                {t("control.preview.truncated")}
              </span>
            )}
            {/*
              A latching function button on a panel, not a switch: its own track
              tells you whether it is down.
            */}
            <SegmentTrack className="ml-auto shrink-0">
              <button
                type="button"
                className={cn(segmentClass(painting), "h-11 touch-manipulation px-3")}
                style={segmentStyle(painting)}
                onClick={() => setPainting((on) => !on)}
                aria-pressed={painting}
                disabled={pending}
                data-testid="control-paint-mode"
              >
                {t("control.paint.toggle")}
              </button>
            </SegmentTrack>
          </div>

          {/*
            The *only* palette on this screen — eight windows, shared by every
            tap, drag and row handle. Full width, because it is the second half of
            the job and there is nothing to share the line with.
          */}
          {painting && (
            <div
              className="flex items-stretch gap-1"
              role="radiogroup"
              aria-label={t("control.paint.color_label")}
            >
              {BOARD_COLORS.map((color) => {
                const active = paintColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={t(`control.colors.${color}`)}
                    title={t(`control.colors.${color}`)}
                    onClick={() => setPaintColor(color)}
                    disabled={pending}
                    className="flex h-11 min-w-0 flex-1 basis-0 items-center justify-center disabled:opacity-40"
                    data-testid={`control-paint-color-${color}`}
                  >
                    <FlapSwatch color={color} active={active} />
                  </button>
                );
              })}
            </div>
          )}

          {painting && (
            <p
              className="px-1 text-[10px] leading-relaxed"
              style={{ color: CONSOLE.inkMute }}
              data-testid="control-paint-hint"
            >
              {t("control.paint.hint")}
            </p>
          )}

          {showingLive ? (
            /*
              The real thing, with the real animator — 144 tiles fed by the
              controller's socket. Silent: the clatter belongs to the room the
              television is in, not to the phone in someone's hand.
            */
            <div
              className="p-2"
              style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
              data-testid="control-board-mirror"
            >
              <BoardGridView grid={liveGrid} variant="inline" />
            </div>
          ) : (
            <BoardPreview
              grid={compiled.grid}
              onPaintCell={painting ? paint : undefined}
              onPaintStroke={painting ? paintStroke : undefined}
              onPaintRow={painting ? paintRow : undefined}
              paintColor={painting ? paintColor : undefined}
              cellLabel={cellLabel}
              rowLabel={rowLabel}
              disabled={pending}
            />
          )}
        </section>

        {/*
          The six typing wells, now BELOW the grid and behind a disclosure.

          The plan called for them to be "behind a toggle for precise edits", and
          this is that with one deliberate difference: the disclosure **defaults
          open**. Collapsing the only text input on the screen by default would
          hide the primary path behind a tap in order to promote the secondary
          one, which is the opposite of what promoting the grid was for. What the
          toggle actually buys is the *paint* workflow — arm paint, fold the
          keyboard's worth of wells away, and the board is the whole screen.
        */}
        <section className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={rowsOpen}
            onClick={() => setRowsOpen((open) => !open)}
            className="flex min-h-11 touch-manipulation items-center justify-between px-1 text-[10px] leading-none font-medium uppercase"
            style={{ color: CONSOLE.inkMute, letterSpacing: "0.2em" }}
            data-testid="control-editor-rows-toggle"
          >
            {t("control.editor.title")}
            <IconChevronDown
              aria-hidden
              className={cn("size-4 transition-transform", rowsOpen && "rotate-180")}
            />
          </button>
          {rowsOpen && (
            <div
              className="flex flex-col gap-1.5 rounded-none p-2"
              style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
              data-testid="control-editor-rows"
            >
              {values.rows.map((row, index) => (
                <RowWell
                  key={index}
                  form={form}
                  index={index}
                  active={index === activeRow}
                  segments={row.segments.length}
                  pending={pending}
                  locked={painting}
                  onFocus={() => setActiveRow(index)}
                  onEnter={() => {
                    if (index < BOARD_ROWS - 1) focusRow(index + 1);
                  }}
                />
              ))}
            </div>
          )}
        </section>

        {/*
          Last, and small: the controls that used to be repeated six times. They
          sit *after* the board because they are what you reach for once the board
          is nearly right — and because nothing may come between the typing and
          the grid.
        */}
        {activeRowValues !== undefined && (
          <RowDetail
            form={form}
            index={activeRow}
            row={activeRowValues}
            pending={pending}
            locked={painting}
          />
        )}

        <div className="flex items-stretch gap-2">
          {/* Ghost: a hairline and nothing else. Destructive-ish, so it must not
              compete with the one action that reaches someone's living room. */}
          <button
            type="button"
            className="h-12 flex-1 rounded-none text-[11px] font-medium uppercase disabled:opacity-40"
            style={{
              color: CONSOLE.inkDim,
              letterSpacing: "0.16em",
              boxShadow: `inset 0 0 0 1px ${CONSOLE.hairline}`,
            }}
            disabled={pending}
            onClick={() => form.reset(emptyEditorValues())}
            data-testid="control-clear"
          >
            {t("control.editor.clear")}
          </button>
          {/* The console's one filled control: off-white plate, dark legend. */}
          <button
            type="submit"
            className="h-12 flex-[2] rounded-none text-[12px] font-semibold uppercase disabled:opacity-40"
            style={{
              backgroundColor: CONSOLE.ink,
              color: CONSOLE.panel,
              letterSpacing: "0.18em",
              boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.28)",
            }}
            disabled={pending}
            data-testid="control-send"
          >
            {pending ? t("control.sending") : t("control.send")}
          </button>
        </div>
      </form>
    </Form>
  );
}
