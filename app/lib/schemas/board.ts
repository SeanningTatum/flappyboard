import { Schema } from "effect";

export const BOARD_ROWS = 6;
export const BOARD_COLS = 24;

/**
 * Every character a flap can physically show. A real split-flap has a fixed set
 * of flaps per tile — this is ours. Order is irrelevant; membership is not.
 */
export const BOARD_CHARS =
  " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$()-+&=;:'\"%,.?/°";

const boardCharSet: ReadonlySet<string> = new Set(BOARD_CHARS.split(""));

export const isBoardChar = (value: string): boolean =>
  value.length === 1 && boardCharSet.has(value);

/**
 * `black` is the off/background tile, not a paint colour — a blank cell is
 * always `{ char: " ", color: "black" }`. A space in any other colour is a
 * deliberate colour tile.
 */
export const BoardColor = Schema.Literal(
  "white",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "violet",
  "black"
);
export type BoardColor = typeof BoardColor.Type;

export const DEFAULT_COLOR = "white" as const satisfies BoardColor;
export const BLANK_COLOR = "black" as const satisfies BoardColor;

export const BOARD_COLORS = BoardColor.literals;

/**
 * `spread` is a real alignment, not an editor convenience: the row's segments are
 * distributed across all `BOARD_COLS` columns — first flush left, last flush
 * right, any middle ones evenly spaced — with unlit gaps between them. It exists
 * here rather than only in the editor because the *writers* that most need it (the
 * LLM) can only reach this schema, and a writer that cannot say "flush right" pads
 * with hand-counted spaces and gets it wrong. `compile.ts` owns the layout.
 */
export const BoardAlign = Schema.Literal("left", "center", "right", "spread");
export type BoardAlign = typeof BoardAlign.Type;

export const BOARD_ALIGNS = BoardAlign.literals;

export const BoardChar = Schema.String.pipe(
  Schema.filter((value) => isBoardChar(value), {
    message: () => `Character must be one of: ${BOARD_CHARS}`,
  })
);

export const BoardCell = Schema.Struct({
  char: BoardChar,
  color: BoardColor,
});
export type BoardCell = typeof BoardCell.Type;

export const BoardCellRow = Schema.Array(BoardCell).pipe(
  Schema.itemsCount(BOARD_COLS)
);
export type BoardCellRow = typeof BoardCellRow.Type;

/**
 * The rendered board — always exactly BOARD_ROWS × BOARD_COLS. Only the
 * compiler produces these; callers never hand-build a grid.
 */
export const BoardGrid = Schema.Struct({
  rows: Schema.Array(BoardCellRow).pipe(Schema.itemsCount(BOARD_ROWS)),
});
export type BoardGrid = typeof BoardGrid.Type;

/** Upper bound on a single segment's text — generous, but not unbounded. */
export const MAX_SEGMENT_TEXT = 200;

export const BoardSegment = Schema.Struct({
  text: Schema.String.pipe(Schema.maxLength(MAX_SEGMENT_TEXT)),
  color: Schema.optionalWith(BoardColor, { default: () => DEFAULT_COLOR }),
});
export type BoardSegment = typeof BoardSegment.Type;

export const BoardMessageRow = Schema.Struct({
  align: Schema.optionalWith(BoardAlign, { default: () => "left" as const }),
  segments: Schema.Array(BoardSegment).pipe(Schema.maxItems(BOARD_COLS)),
});
export type BoardMessageRow = typeof BoardMessageRow.Type;

/**
 * The semantic layer every writer (phone, LLM) produces. Deliberately smaller
 * and looser than a grid: the compiler owns wrapping, alignment, charset
 * legality and the 6×24 invariant, so no caller can get those wrong.
 */
export const BoardMessage = Schema.Struct({
  rows: Schema.Array(BoardMessageRow).pipe(Schema.maxItems(BOARD_ROWS)),
});
export type BoardMessage = typeof BoardMessage.Type;

export const decodeBoardMessage = Schema.decodeUnknownEither(BoardMessage);
export const decodeBoardGrid = Schema.decodeUnknownEither(BoardGrid);

/**
 * The board router's reply: one boolean deciding whether the request needs the
 * web search tool attached.
 *
 * Mirrors `BOARD_ROUTER_SCHEMA` in `app/services/board-agent.ts` exactly as
 * `BoardMessage` mirrors `BOARD_MESSAGE_JSON_SCHEMA` — structured outputs buy the
 * shape, this buys the guarantee. It matters here because a *truthy* answer and a
 * *true* answer are not the same thing: coercing `"yes"` or `1` would silently
 * turn every malformed reply into "search", which is the expensive branch.
 */
export const RouterDecision = Schema.Struct({
  needs_live_data: Schema.Boolean,
});
export type RouterDecision = typeof RouterDecision.Type;

export const decodeRouterDecision = Schema.decodeUnknownEither(RouterDecision);

/* -------------------------------------------------------------------------- */
/* Persistence / route inputs                                                 */
/* -------------------------------------------------------------------------- */

/** Board and snapshot primary keys are UUIDs today — 64 is generous headroom. */
export const MAX_BOARD_ID = 64;

export const BoardId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_BOARD_ID)
);
export type BoardId = typeof BoardId.Type;

/**
 * Where a snapshot came from. `automation` is reserved for the future paid
 * automations feature — nothing writes it yet, but the column accepts it so a
 * later feature needs no migration.
 */
export const BoardSource = Schema.Literal("manual", "llm", "automation");
export type BoardSource = typeof BoardSource.Type;

export const DEFAULT_BOARD_NAME = "flappyboard";
export const DEFAULT_SOUND_PACK = "classic";

export const MAX_BOARD_NAME = 60;
export const MAX_SOUND_PACK = 32;
/** Upper bound on the prompt we keep alongside an LLM-authored snapshot. */
export const MAX_BOARD_PROMPT = 500;

export const BoardName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_BOARD_NAME)
);

export const SoundPack = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(MAX_SOUND_PACK)
);

export const CreateBoardInput = Schema.Struct({
  ownerId: Schema.String.pipe(Schema.minLength(1)),
  name: Schema.optionalWith(BoardName, {
    default: () => DEFAULT_BOARD_NAME,
  }),
});
export type CreateBoardInput = typeof CreateBoardInput.Type;

export const GetBoardInput = Schema.Struct({
  boardId: BoardId,
});
export type GetBoardInput = typeof GetBoardInput.Type;

export const SaveSnapshotInput = Schema.Struct({
  boardId: BoardId,
  revision: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  grid: BoardGrid,
  source: Schema.optionalWith(BoardSource, {
    default: () => "manual" as const,
  }),
  prompt: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_BOARD_PROMPT))
  ),
});
export type SaveSnapshotInput = typeof SaveSnapshotInput.Type;

export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

export const GetHistoryInput = Schema.Struct({
  boardId: BoardId,
  limit: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_HISTORY_LIMIT),
    Schema.optionalWith({ default: () => DEFAULT_HISTORY_LIMIT })
  ),
});
export type GetHistoryInput = typeof GetHistoryInput.Type;

/**
 * What the **repository** is asked for: `GetHistoryInput` plus `since`, a floor
 * on `createdAt` in epoch ms.
 *
 * `since` is deliberately absent from `GetHistoryInput`, which is the schema the
 * client's input is decoded against. It is derived on the server from the
 * caller's own grant (`grantHistoryFloor` in `app/lib/board/pairing.ts`), so
 * there is no field a caller could set, widen, or omit — a separate type is the
 * cheapest way to make "the client cannot reach this" true by construction
 * rather than by remembering to overwrite it.
 */
export const GetHistoryQuery = Schema.Struct({
  ...GetHistoryInput.fields,
  since: Schema.optional(
    Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0))
  ),
});
export type GetHistoryQuery = typeof GetHistoryQuery.Type;

export const UpdateBoardSettingsInput = Schema.Struct({
  boardId: BoardId,
  soundPack: Schema.optional(SoundPack),
  muted: Schema.optional(Schema.Boolean),
});
export type UpdateBoardSettingsInput = typeof UpdateBoardSettingsInput.Type;

/**
 * Delete is owner-only and irreversible — see `requireOwnedBoard` in
 * `app/trpc/routes/board.ts`. `boardId` is the only input; existence is
 * verified by the repository (`getBoard`) before the delete runs.
 */
export const DeleteBoardInput = Schema.Struct({
  boardId: BoardId,
});
export type DeleteBoardInput = typeof DeleteBoardInput.Type;

/** Rename is owner-only. `name` reuses `BoardName` — never blank, bounded. */
export const RenameBoardInput = Schema.Struct({
  boardId: BoardId,
  name: BoardName,
});
export type RenameBoardInput = typeof RenameBoardInput.Type;

/**
 * Revoke every controller for one board. Owner-only and, like `delete`, takes
 * nothing but the id — there is no "revoke this one phone", because a grant
 * carries no device identity by design (see `app/lib/board/pairing.ts`). The
 * board's `grantEpoch` is the only thing that moves.
 */
export const RevokeControllersInput = Schema.Struct({
  boardId: BoardId,
});
export type RevokeControllersInput = typeof RevokeControllersInput.Type;

/**
 * A write from a client. `baseRevision` is the revision the writer believed it
 * was editing — the room applies the write regardless (last write wins) and
 * echoes back the truth, so this is a diagnostic, not a lock.
 */
export const SetBoardMessageInput = Schema.Struct({
  boardId: BoardId,
  baseRevision: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0)
  ),
  message: BoardMessage,
  source: Schema.optionalWith(BoardSource, { default: () => "manual" as const }),
  prompt: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_BOARD_PROMPT))
  ),
});
export type SetBoardMessageInput = typeof SetBoardMessageInput.Type;

/**
 * What a human types (or says) to the board agent. Bounded by the same
 * `MAX_BOARD_PROMPT` as the stored column, since the prompt is persisted
 * alongside the snapshot it produced. Whitespace-only is rejected here rather
 * than being spent on a model call that could only fail.
 */
export const BoardPrompt = Schema.String.pipe(
  Schema.maxLength(MAX_BOARD_PROMPT),
  Schema.filter((value) => value.trim().length > 0, {
    message: () => "Prompt must not be empty",
  })
);
export type BoardPrompt = typeof BoardPrompt.Type;

/**
 * A request for the LLM to author the board. `baseRevision` carries the same
 * meaning as in `SetBoardMessageInput` — diagnostic, not a lock — because the
 * generated message is written through the room's single write path.
 */
export const GenerateBoardMessageInput = Schema.Struct({
  boardId: BoardId,
  baseRevision: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(0)
  ),
  prompt: BoardPrompt,
});
export type GenerateBoardMessageInput = typeof GenerateBoardMessageInput.Type;

export const CreateBoardRouteInput = Schema.Struct({
  name: Schema.optionalWith(BoardName, { default: () => DEFAULT_BOARD_NAME }),
});
export type CreateBoardRouteInput = typeof CreateBoardRouteInput.Type;

export const decodeCreateBoardInput = Schema.decodeUnknownEither(CreateBoardInput);
export const decodeSaveSnapshotInput = Schema.decodeUnknownEither(SaveSnapshotInput);
export const decodeGetHistoryInput = Schema.decodeUnknownEither(GetHistoryInput);
export const decodeGetHistoryQuery = Schema.decodeUnknownEither(GetHistoryQuery);
