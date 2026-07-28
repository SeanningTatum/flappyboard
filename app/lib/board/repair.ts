import {
  BOARD_ALIGNS,
  BOARD_COLORS,
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_COLOR,
  MAX_SEGMENT_TEXT,
  decodeBoardMessage,
  type BoardAlign,
  type BoardColor,
  type BoardMessage,
  type BoardMessageRow,
  type BoardSegment,
} from "@/lib/schemas/board";
import { Either } from "effect";

const colorSet: ReadonlySet<string> = new Set(BOARD_COLORS);
/** Derived, not restated: a new alignment must not need a second edit here. */
const alignSet: ReadonlySet<string> = new Set(BOARD_ALIGNS);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asColor = (value: unknown): BoardColor =>
  typeof value === "string" && colorSet.has(value)
    ? (value as BoardColor)
    : DEFAULT_COLOR;

const asAlign = (value: unknown): BoardAlign =>
  typeof value === "string" && alignSet.has(value)
    ? (value as BoardAlign)
    : "left";

/** Scalars stringify; anything structural becomes empty rather than "[object Object]". */
const asText = (value: unknown): string => {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  return text.slice(0, MAX_SEGMENT_TEXT);
};

const repairSegment = (value: unknown): BoardSegment => {
  if (isRecord(value)) {
    return { text: asText(value.text), color: asColor(value.color) };
  }
  return { text: asText(value), color: DEFAULT_COLOR };
};

const repairSegments = (value: unknown): ReadonlyArray<BoardSegment> => {
  if (Array.isArray(value)) {
    return value.slice(0, BOARD_COLS).map(repairSegment);
  }
  if (value === undefined || value === null) return [];
  return [repairSegment(value)];
};

const repairRow = (value: unknown): BoardMessageRow => {
  if (Array.isArray(value)) {
    return { align: "left", segments: repairSegments(value) };
  }
  if (isRecord(value)) {
    const segments =
      value.segments !== undefined
        ? repairSegments(value.segments)
        : repairSegments(value.text);
    return { align: asAlign(value.align), segments };
  }
  return { align: "left", segments: repairSegments(value) };
};

const extractRows = (input: unknown): ReadonlyArray<unknown> => {
  if (Array.isArray(input)) return input;
  if (isRecord(input) && Array.isArray(input.rows)) return input.rows;
  if (isRecord(input) && input.rows !== undefined) return [input.rows];
  if (typeof input === "string") return [input];
  return [];
};

/**
 * Last resort when a writer (usually a model) hands us something that won't
 * decode: coerce whatever is salvageable into a valid BoardMessage instead of
 * failing. Total, pure, and never throws — the board always gets to update.
 */
export const repairMessage = (input: unknown): BoardMessage => ({
  rows: extractRows(input).slice(0, BOARD_ROWS).map(repairRow),
});

export interface RepairResult {
  readonly message: BoardMessage;
  /** True when the input failed to decode and had to be coerced. */
  readonly repaired: boolean;
}

/**
 * Decode first, repair only on failure. Callers get a valid message either way,
 * plus the flag they need to tell the user their text was adjusted.
 */
export const decodeOrRepair = (input: unknown): RepairResult => {
  const decoded = decodeBoardMessage(input);
  return Either.isRight(decoded)
    ? { message: decoded.right, repaired: false }
    : { message: repairMessage(input), repaired: true };
};
