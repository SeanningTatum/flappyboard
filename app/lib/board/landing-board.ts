import { blankGrid, compileMessage, normalizeText } from "@/lib/board/compile";
import {
  BOARD_COLS,
  BOARD_ROWS,
  type BoardColor,
  type BoardGrid,
  type BoardMessage,
} from "@/lib/schemas/board";

/**
 * What the landing page's board says, and what a visitor's typing turns it into.
 *
 * This is the whole bridge between a text field on `/` and the frozen 6×24
 * animator. Nothing here hand-builds a grid: `compileMessage` owns the invariant
 * (`compile.ts`), so wrapping, the charset fold and the 144-cell shape are the
 * same code the television runs. A landing page that compiled its own grid would
 * be a second, quietly diverging board.
 */

/** Every cell the board has. The counter under the input is measured against it. */
export const BOARD_CAPACITY = BOARD_ROWS * BOARD_COLS;

/**
 * The board's opening words — **fixed Latin in every locale**, deliberately.
 *
 * `BOARD_CHARS` is Latin by construction (a property of the object, not an
 * oversight), so a translated string folds to nothing and `foldsToFlaps`
 * (`flap-word.tsx:174`) is false for all of `zh`. Rather than hack a fallback,
 * the flaps stay Latin and the translated sentence lives in prose beside them:
 * a real split-flap shows Latin flaps to a Chinese owner too. Recorded in
 * `.brain/features/front-door/front-door.md`, decision ledger, "Type".
 *
 * Yellow is spent once — the invitation. The rest is lit white on unlit cards,
 * which is what the object does when nobody has painted anything.
 */
const OPENING_LINES: ReadonlyArray<readonly [text: string, color: BoardColor]> =
  [
    ["", "white"],
    ["SAY SOMETHING", "yellow"],
    ["TO THE LIVING ROOM", "white"],
    ["", "white"],
    // Not "type it below": on a laptop the field is beside the board, not under
    // it, and a board that gives the wrong direction is a board nobody trusts.
    ["GO ON. YOU DRIVE IT.", "white"],
  ];

const centered = (
  lines: ReadonlyArray<readonly [string, BoardColor]>
): BoardMessage => ({
  rows: lines.map(([text, color]) => ({
    align: "center" as const,
    segments: [{ text, color }],
  })),
});

/**
 * Module-level constants, not factories: the animator compares grid **identity**
 * (`board-grid-view.tsx:527`) to decide whether anything changed, so handing it
 * a freshly built but identical grid would re-plan 144 tiles for nothing.
 */
export const OPENING_GRID: BoardGrid = compileMessage(centered(OPENING_LINES)).grid;

/** What the board is showing before the client has mounted. See `home.tsx`. */
export const BLANK_GRID: BoardGrid = blankGrid();

/**
 * Why a hint is showing under the input.
 *
 * - `dropped` — some characters have no flap and were left off.
 * - `nothing` — *no* character has a flap. The CJK case: a `zh` visitor typing
 *   into the box folds away entirely, so the board keeps what it last showed
 *   rather than going blank, and the hint says why.
 * - `full` — more than the board holds; the overflow fell off the bottom.
 */
export type BoardNote = "none" | "dropped" | "nothing" | "full";

export interface TypedBoard {
  /** `null` means "nothing in that line has a flap" — hold the current grid. */
  readonly grid: BoardGrid | null;
  readonly note: BoardNote;
  /** Cells the text consumes, for the counter. Clamped to the board. */
  readonly used: number;
}

/**
 * The typed text, as the board would show it.
 *
 * An empty box is not an empty board: it is the opening message, so clearing the
 * input flips the board back to what it said on arrival instead of leaving a
 * blank rectangle where the product used to be.
 */
export const typedBoard = (text: string): TypedBoard => {
  if (text.trim() === "") {
    return { grid: OPENING_GRID, note: "none", used: 0 };
  }

  const folded = normalizeText(text);
  if (folded.trim() === "") {
    return { grid: null, note: "nothing", used: 0 };
  }

  const compiled = compileMessage({
    rows: [{ align: "center", segments: [{ text, color: "white" }] }],
  });

  const note: BoardNote =
    compiled.droppedLines > 0
      ? "full"
      : compiled.droppedChars > 0
        ? "dropped"
        : "none";

  return {
    grid: compiled.grid,
    note,
    used: Math.min(folded.length, BOARD_CAPACITY),
  };
};

/** Exported for the test, so the opening copy cannot silently overflow a row. */
export const OPENING_TEXT: ReadonlyArray<string> = OPENING_LINES.map(
  ([text]) => text
);
