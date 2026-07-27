import {
  BLANK_COLOR,
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_COLOR,
  isBoardChar,
  type BoardAlign,
  type BoardCell,
  type BoardCellRow,
  type BoardColor,
  type BoardGrid,
  type BoardMessage,
  type BoardMessageRow,
  type BoardSegment,
} from "@/lib/schemas/board";

export const BLANK_CELL: BoardCell = { char: " ", color: BLANK_COLOR };

/**
 * Characters a flap can't show but that map cleanly onto one that can. Applied
 * after uppercasing and diacritic stripping, so only the residue lands here.
 */
const CHAR_ALIASES: Readonly<Record<string, string>> = {
  "_": "-",
  "*": "+",
  "~": "-",
  "^": "+",
  "[": "(",
  "]": ")",
  "{": "(",
  "}": ")",
  "<": "(",
  ">": ")",
  "|": "/",
  "\\": "/",
  "`": "'",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  "•": "-",
  "€": "$",
  "£": "$",
  "¥": "$",
  "\t": " ",
  "\n": " ",
  "\r": " ",
};

interface Normalized {
  readonly text: string;
  readonly dropped: number;
}

const normalize = (text: string): Normalized => {
  const folded = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();

  let out = "";
  let dropped = 0;
  for (const char of folded) {
    if (isBoardChar(char)) {
      out += char;
      continue;
    }
    const alias = CHAR_ALIASES[char];
    if (alias !== undefined) {
      out += alias;
      continue;
    }
    dropped += 1;
  }
  return { text: out, dropped };
};

/** Text as the board would show it: uppercased, de-accented, illegal chars dropped. */
export const normalizeText = (text: string): string => normalize(text).text;

/** The two colours in which a space was never a tile: white text, unlit card. */
const isSeparatorColor = (color: BoardColor): boolean =>
  color === DEFAULT_COLOR || color === BLANK_COLOR;

/** After `normalize`, so tabs and newlines already count as spaces. */
const isAllSpaces = (text: string): boolean =>
  text.length > 0 && [...text].every((char) => char === " ");

/**
 * **Colour applies to glyphs.** Only a segment that is *entirely* spaces turns
 * its spaces into lit tiles.
 *
 * The rule used to be flatter — "a space carrying a colour is a lit tile,
 * whatever else is in the segment" — and it cost more than it bought. A writer
 * (usually the LLM) emitting `{ text: "HAPPY FRIDAY!", color: "green" }` meant
 * *green letters*, and got a lit green tile in the gap between the two words:
 * `HAPPY#FRIDAY!`. Measured over one eval, 17 stray tiles across 15 boards, and
 * every one of them a divergence from the object being imitated — a real board's
 * inter-word gap is an unlit card.
 *
 * Restricting it to all-space segments keeps everything the flat rule was *for*:
 *
 * - A 24-space coloured segment is still a solid bar, so frames and borders work.
 * - A one-space coloured segment is still one lit tile, which is exactly the shape
 *   a per-cell paint round-trips into (`cell-paint.ts` → `gridToMessage`), so the
 *   paint layer keeps reproducing painted grids exactly.
 *
 * What it changes, deliberately, is that a coloured *word* segment now behaves
 * like an uncoloured one: its interior spaces are separators, which means they
 * normalise to `BLANK_CELL`, they collapse at a wrap boundary, and a long coloured
 * segment now wraps **between its words** instead of being carried as one atomic
 * token and hard-split at column 24. Both are the uncoloured behaviour, and both
 * are improvements; they are asserted in `compile.test.ts`.
 *
 * A writer that wants a lit gap inside coloured text says so with its own
 * segment — `[{ "HAPPY", green }, { " ", green }, { "FRIDAY!", green }]` — which is
 * also precisely what painting that gap produces.
 */
const isSeparatorSpace = (
  char: string,
  color: BoardColor,
  allSpaces: boolean
): boolean => char === " " && (isSeparatorColor(color) || !allSpaces);

interface Token {
  readonly kind: "word" | "gap";
  readonly cells: ReadonlyArray<BoardCell>;
}

const tokenizeRow = (
  segments: ReadonlyArray<BoardSegment>
): { tokens: ReadonlyArray<Token>; dropped: number } => {
  const tokens: Token[] = [];
  let dropped = 0;

  for (const segment of segments) {
    const { text, dropped: segmentDropped } = normalize(segment.text);
    dropped += segmentDropped;
    // Measured on the *normalised* text: a segment of tabs is a segment of
    // spaces, and a segment of emoji is a segment of nothing.
    const allSpaces = isAllSpaces(text);

    for (const char of text) {
      const separator = isSeparatorSpace(char, segment.color, allSpaces);
      const cell: BoardCell = separator
        ? BLANK_CELL
        : { char, color: segment.color };
      const kind = separator ? "gap" : "word";
      const last = tokens[tokens.length - 1];
      if (last !== undefined && last.kind === kind) {
        tokens[tokens.length - 1] = { kind, cells: [...last.cells, cell] };
      } else {
        tokens.push({ kind, cells: [cell] });
      }
    }
  }

  return { tokens, dropped };
};

/**
 * One segment's cells, with no token merging — `spread` needs the runs kept apart
 * so it can measure them, whereas `wrapTokens` wants them coalesced.
 */
const segmentCells = (
  segment: BoardSegment
): { cells: ReadonlyArray<BoardCell>; dropped: number } => {
  const { text, dropped } = normalize(segment.text);
  const allSpaces = isAllSpaces(text);
  const cells = [...text].map((char) =>
    isSeparatorSpace(char, segment.color, allSpaces)
      ? BLANK_CELL
      : { char, color: segment.color }
  );
  return { cells, dropped };
};

/**
 * `spread`: distribute the row's segments across exactly `BOARD_COLS` — first
 * flush left, last flush right, middles evenly spaced.
 *
 * This is the layout a label/value row wants (`RAIN` … `30%`), and it lives in the
 * compiler because the alternative — a writer padding with literal spaces — needs
 * the writer to count to 24 in a charset where `12°` is three cells and an emoji is
 * zero. Widths are therefore measured **after** `normalize`, on the cells the board
 * will really show.
 *
 * Three properties are load-bearing:
 *
 * - **The gaps are `BLANK_CELL`.** A gap is all spaces, which is exactly the case
 *   in which a colour *does* light a space, so a coloured gap would draw a bright
 *   bar between the label and its value.
 * - **A spread row never wraps.** It is one row by construction; if the content
 *   cannot fit, the gaps collapse to a single column each and the row clips at the
 *   right edge, reported through `droppedChars`. Wrapping is what produced the
 *   `SKY` / `CLOUDY` split this alignment exists to prevent.
 * - **Zero-width segments do not count.** A segment whose text normalises to
 *   nothing is not a participant, so it neither earns a gap nor shifts the others.
 *   That makes a one-segment spread row identical to `left`.
 *
 * Remainder columns go to the **leftmost** gaps. The first and last segments are
 * pinned to the edges, so only interior segments can absorb slack; giving it to the
 * earliest gaps first is deterministic, and it biases interior content away from
 * the left-hand label — which is the segment most likely to be long.
 */
const spreadCells = (
  segments: ReadonlyArray<BoardSegment>
): { cells: ReadonlyArray<BoardCell>; dropped: number } => {
  const runs: Array<ReadonlyArray<BoardCell>> = [];
  let dropped = 0;

  for (const segment of segments) {
    const { cells, dropped: segmentDropped } = segmentCells(segment);
    dropped += segmentDropped;
    if (cells.length > 0) runs.push(cells);
  }

  const gaps = runs.length - 1;
  if (gaps < 1) return { cells: runs[0] ?? [], dropped };

  const content = runs.reduce((total, run) => total + run.length, 0);
  const free = BOARD_COLS - content;
  // `free <= gaps` means there is not even one column per gap: collapse to the
  // minimum and let `padLine` clip, rather than wrap or rewrite the text.
  const tight = free <= gaps;
  const base = tight ? 1 : Math.floor(free / gaps);
  const remainder = tight ? 0 : free % gaps;

  const cells: BoardCell[] = [];
  runs.forEach((run, index) => {
    if (index > 0) {
      const width = base + (index <= remainder ? 1 : 0);
      for (let i = 0; i < width; i += 1) cells.push(BLANK_CELL);
    }
    cells.push(...run);
  });

  return { cells, dropped };
};

const trimTrailingBlanks = (
  cells: ReadonlyArray<BoardCell>
): ReadonlyArray<BoardCell> => {
  let end = cells.length;
  while (end > 0) {
    const cell = cells[end - 1]!;
    if (cell.char !== " " || cell.color !== BLANK_COLOR) break;
    end -= 1;
  }
  return cells.slice(0, end);
};

/**
 * Greedy word wrap to BOARD_COLS. A word longer than the board is hard-split
 * rather than dropped — better a broken word than a missing one.
 */
const wrapTokens = (
  tokens: ReadonlyArray<Token>
): ReadonlyArray<ReadonlyArray<BoardCell>> => {
  const lines: Array<ReadonlyArray<BoardCell>> = [];
  let current: BoardCell[] = [];

  const flush = () => {
    lines.push(trimTrailingBlanks(current));
    current = [];
  };

  for (const token of tokens) {
    if (token.kind === "gap") {
      if (current.length === 0) continue;
      if (current.length + token.cells.length > BOARD_COLS) {
        flush();
        continue;
      }
      current.push(...token.cells);
      continue;
    }

    if (token.cells.length > BOARD_COLS) {
      if (current.length > 0) flush();
      for (let i = 0; i < token.cells.length; i += BOARD_COLS) {
        const chunk = token.cells.slice(i, i + BOARD_COLS);
        if (chunk.length === BOARD_COLS) {
          lines.push(chunk);
        } else {
          current = [...chunk];
        }
      }
      continue;
    }

    if (current.length + token.cells.length > BOARD_COLS) flush();
    current.push(...token.cells);
  }

  if (current.length > 0) flush();
  return lines;
};

/**
 * Clip to the board and pad the free columns out with unlit cells. `spread` is
 * excluded from the type rather than handled here: it decides its *own* interior
 * columns, so by the time it reaches this function it is already a full-width row
 * and the only thing left to do is clip.
 */
const padLine = (
  cells: ReadonlyArray<BoardCell>,
  align: Exclude<BoardAlign, "spread">
): BoardCellRow => {
  const clipped = cells.slice(0, BOARD_COLS);
  const free = BOARD_COLS - clipped.length;
  const left =
    align === "center" ? Math.floor(free / 2) : align === "right" ? free : 0;
  return [
    ...Array.from({ length: left }, () => BLANK_CELL),
    ...clipped,
    ...Array.from({ length: free - left }, () => BLANK_CELL),
  ];
};

export const blankRow = (): BoardCellRow => padLine([], "left");

export const blankGrid = (): BoardGrid => ({
  rows: Array.from({ length: BOARD_ROWS }, () => blankRow()),
});

const compileRow = (
  row: BoardMessageRow
): { lines: ReadonlyArray<BoardCellRow>; dropped: number } => {
  const align = row.align;
  if (align === "spread") {
    const { cells, dropped } = spreadCells(row.segments);
    // A clipped spread row is honest about it rather than wrapping: the columns
    // that fell off the right edge are reported as dropped characters.
    const clipped = Math.max(0, cells.length - BOARD_COLS);
    return { lines: [padLine(cells, "left")], dropped: dropped + clipped };
  }

  const { tokens, dropped } = tokenizeRow(row.segments);
  const wrapped = wrapTokens(tokens);
  // An empty semantic row still occupies a board row — vertical layout is
  // meaningful, so callers can space content out with blank rows.
  const lines = wrapped.length === 0 ? [[]] : wrapped;
  return { lines: lines.map((line) => padLine(line, align)), dropped };
};

export interface CompileResult {
  readonly grid: BoardGrid;
  /** True when any content was lost — drives the "trimmed to fit" hint. */
  readonly truncated: boolean;
  readonly droppedLines: number;
  readonly droppedChars: number;
}

/**
 * The 6×24 invariant lives here and nowhere else: whatever a writer produces,
 * this returns a grid of exactly BOARD_ROWS rows of exactly BOARD_COLS cells.
 */
export const compileMessage = (message: BoardMessage): CompileResult => {
  const lines: BoardCellRow[] = [];
  let droppedChars = 0;

  for (const row of message.rows) {
    const compiled = compileRow(row);
    droppedChars += compiled.dropped;
    lines.push(...compiled.lines);
  }

  const kept = lines.slice(0, BOARD_ROWS);
  const droppedLines = lines.length - kept.length;
  while (kept.length < BOARD_ROWS) kept.push(blankRow());

  return {
    grid: { rows: kept },
    truncated: droppedLines > 0 || droppedChars > 0,
    droppedLines,
    droppedChars,
  };
};

/** Convenience for callers that only want the grid. */
export const compileToGrid = (message: BoardMessage): BoardGrid =>
  compileMessage(message).grid;
