import { Either, Schema } from "effect";
import { BoardGrid, BoardMessage, BoardSource, SoundPack } from "@/lib/schemas/board";
import { blankGrid, compileMessage } from "./compile";
import { decodeOrRepair } from "./repair";

/**
 * The live board-room wire protocol: what a phone (or the coordinator) sends,
 * what every connected board receives.
 *
 * This module is deliberately pure and platform-free — the Durable Object owns
 * sockets, storage and D1; this owns *meaning*. Every export is total (no
 * throws, no I/O), which is what makes the protocol unit-testable without
 * miniflare and keeps exactly one compile site for a message → grid.
 */

/** Upper bound on the stored prompt — bounded so a model can't fill D1. */
export const MAX_PROMPT_LENGTH = 500;

export const DEFAULT_SOUND_PACK = "classic";

/** Revisions are monotonic counters: non-negative integers, never floats. */
const Revision = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0)
);

// ---------------------------------------------------------------------------
// Client → server
// ---------------------------------------------------------------------------

/**
 * The wire accepts every source the `board_snapshot.source` column accepts —
 * including `automation`, which nothing writes yet. Narrowing this to the two
 * sources in use today would silently relabel a future automation write as
 * `manual` instead of rejecting it, and a silent mislabel in history is worse
 * than an unused enum member.
 */
export const BoardCommandSource = BoardSource;
export type BoardCommandSource = typeof BoardCommandSource.Type;

const commandSources: ReadonlySet<string> = new Set(BoardSource.literals);

/** Handshake: "tell me the current board". Carries no payload. */
export const HelloCommand = Schema.Struct({
  type: Schema.Literal("hello"),
});
export type HelloCommand = typeof HelloCommand.Type;

/**
 * `baseRevision` is advisory only — the room is last-write-wins, so a stale
 * value never rejects a write; the sender learns the truth from the echoed
 * state event.
 */
export const SetCommand = Schema.Struct({
  type: Schema.Literal("set"),
  baseRevision: Revision,
  message: BoardMessage,
  source: Schema.optional(BoardCommandSource),
  prompt: Schema.optional(
    Schema.String.pipe(Schema.maxLength(MAX_PROMPT_LENGTH))
  ),
});
export type SetCommand = typeof SetCommand.Type;

export const BoardCommand = Schema.Union(HelloCommand, SetCommand);
export type BoardCommand = typeof BoardCommand.Type;

// ---------------------------------------------------------------------------
// Server → client
// ---------------------------------------------------------------------------

export const BoardStateEvent = Schema.Struct({
  type: Schema.Literal("state"),
  revision: Revision,
  grid: BoardGrid,
  soundPack: Schema.String,
  muted: Schema.Boolean,
  /** Present (and true) only when content was trimmed to fit 6×24. */
  truncated: Schema.optional(Schema.Boolean),
});
export type BoardStateEvent = typeof BoardStateEvent.Type;

export const BoardErrorCode = Schema.Literal(
  "invalid_command",
  "persist_failed"
);
export type BoardErrorCode = typeof BoardErrorCode.Type;

export const BoardErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  code: BoardErrorCode,
});
export type BoardErrorEvent = typeof BoardErrorEvent.Type;

export const BoardEvent = Schema.Union(BoardStateEvent, BoardErrorEvent);
export type BoardEvent = typeof BoardEvent.Type;

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------

/**
 * The authoritative live state of one board. The Durable Object persists this
 * verbatim, so it is untrusted on read (an older deploy may have written it) —
 * hence a schema rather than a bare interface.
 */
export const BoardRoomState = Schema.Struct({
  revision: Revision,
  grid: BoardGrid,
  soundPack: Schema.String,
  muted: Schema.Boolean,
});
export type BoardRoomState = typeof BoardRoomState.Type;

export const initialState = (): BoardRoomState => ({
  revision: 0,
  grid: blankGrid(),
  soundPack: DEFAULT_SOUND_PACK,
  muted: false,
});

// ---------------------------------------------------------------------------
// Parsing — total, never throws
// ---------------------------------------------------------------------------

const decodeCommandSchema = Schema.decodeUnknownEither(BoardCommand);
const decodeEventSchema = Schema.decodeUnknownEither(BoardEvent);
const decodeRoomStateSchema = Schema.decodeUnknownEither(BoardRoomState);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Anything non-numeric, negative, fractional or NaN collapses to 0. */
const asRevision = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;

const asSource = (value: unknown): BoardCommandSource | undefined =>
  typeof value === "string" && commandSources.has(value)
    ? (value as BoardCommandSource)
    : undefined;

const asPrompt = (value: unknown): string | undefined =>
  typeof value === "string" ? value.slice(0, MAX_PROMPT_LENGTH) : undefined;

const decodeText = (raw: string | ArrayBuffer): string | null => {
  if (typeof raw === "string") return raw;
  const decoded = Either.try({
    try: () => new TextDecoder().decode(raw),
    catch: () => "undecodable" as const,
  });
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * Structure is required, payload quality is not: an unknown `type`, a
 * non-object or a `set` with no `message` at all is rejected, but a `message`
 * that merely fails to decode is repaired (`decodeOrRepair`) so a slightly-off
 * write from a model still lands on the board.
 */
export const commandFromUnknown = (input: unknown): BoardCommand | null => {
  if (!isRecord(input)) return null;

  if (input.type === "hello") return { type: "hello" };
  if (input.type !== "set") return null;
  if (input.message === undefined || input.message === null) return null;

  const { message } = decodeOrRepair(input.message);
  const source = asSource(input.source);
  const prompt = asPrompt(input.prompt);

  const candidate = {
    type: "set" as const,
    baseRevision: asRevision(input.baseRevision),
    message,
    ...(source !== undefined ? { source } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
  };

  const decoded = decodeCommandSchema(candidate);
  return Either.isRight(decoded) ? decoded.right : null;
};

/** `null` on anything unparseable — garbage never reaches the reducer. */
export const parseCommand = (raw: string | ArrayBuffer): BoardCommand | null => {
  const text = decodeText(raw);
  if (text === null) return null;
  const parsed = Either.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => "invalid-json" as const,
  });
  return Either.isLeft(parsed) ? null : commandFromUnknown(parsed.right);
};

/** Client-side counterpart of `serializeEvent`. `null` when unparseable. */
export const parseEvent = (raw: string | ArrayBuffer): BoardEvent | null => {
  const text = decodeText(raw);
  if (text === null) return null;
  const parsed = Either.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => "invalid-json" as const,
  });
  if (Either.isLeft(parsed)) return null;
  const decoded = decodeEventSchema(parsed.right);
  return Either.isRight(decoded) ? decoded.right : null;
};

/** Validates persisted room state on read; `null` when it can't be trusted. */
export const decodeRoomState = (input: unknown): BoardRoomState | null => {
  const decoded = decodeRoomStateSchema(input);
  return Either.isRight(decoded) ? decoded.right : null;
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export interface ApplySetResult {
  readonly state: BoardRoomState;
  /** True when the message did not fit and content was dropped. */
  readonly truncated: boolean;
}

/** True when the sender was looking at an older board than the one it hit. */
export const isStale = (state: BoardRoomState, command: SetCommand): boolean =>
  command.baseRevision < state.revision;

/**
 * Last write wins: a stale `baseRevision` is applied anyway and `revision`
 * always steps forward by one, so every listener converges on the same board
 * and the loser of a race sees why in the echoed state.
 */
export const applySet = (
  state: BoardRoomState,
  command: SetCommand
): ApplySetResult => {
  const compiled = compileMessage(command.message);
  return {
    state: {
      ...state,
      revision: state.revision + 1,
      grid: compiled.grid,
    },
    truncated: compiled.truncated,
  };
};

// ---------------------------------------------------------------------------
// Event construction / serialization
// ---------------------------------------------------------------------------

export const stateEvent = (
  state: BoardRoomState,
  truncated = false
): BoardStateEvent => ({
  type: "state",
  revision: state.revision,
  grid: state.grid,
  soundPack: state.soundPack,
  muted: state.muted,
  ...(truncated ? { truncated: true } : {}),
});

export const errorEvent = (code: BoardErrorCode): BoardErrorEvent => ({
  type: "error",
  code,
});

/** Events are plain JSON by construction, so this is total. */
export const serializeEvent = (event: BoardEvent): string =>
  JSON.stringify(event);

// ---------------------------------------------------------------------------
// Control plane — HTTP-only room requests
// ---------------------------------------------------------------------------

/**
 * Two things the room does that are *not* board writes, and that deliberately do
 * **not** live in `BoardCommand`.
 *
 * `BoardCommand` is what a connected socket may send. Settings changes and nonce
 * spends are authorised at the HTTP boundary (an owner session or a controller
 * grant, checked in `app/trpc/routes/board.ts`) and reach the room over the DO
 * stub, never over a socket. Keeping them out of the socket union is the whole
 * enforcement: a browser that already holds a socket cannot mute a board it was
 * never authorised to configure, and — far more importantly — cannot ask the room
 * to burn or probe a pairing nonce.
 */

/**
 * A settings patch. Both fields optional because the phone toggles mute without
 * touching the pack and vice versa; an absent field means "leave it alone",
 * which is not the same as a default.
 */
export const BoardSettingsPatch = Schema.Struct({
  soundPack: Schema.optional(SoundPack),
  muted: Schema.optional(Schema.Boolean),
});
export type BoardSettingsPatch = typeof BoardSettingsPatch.Type;

const decodeSettingsPatchSchema = Schema.decodeUnknownEither(BoardSettingsPatch);

/** `null` on anything unparseable — the room answers 400 rather than guessing. */
export const parseSettingsPatch = (
  raw: string | ArrayBuffer
): BoardSettingsPatch | null => {
  const text = decodeText(raw);
  if (text === null) return null;
  const parsed = Either.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => "invalid-json" as const,
  });
  if (Either.isLeft(parsed)) return null;
  const decoded = decodeSettingsPatchSchema(parsed.right);
  return Either.isRight(decoded) ? decoded.right : null;
};

/**
 * Apply a settings patch. **`revision` is untouched, on purpose.**
 *
 * The revision counts *grid* generations, and the TV's `shouldApplyState` applies
 * an equal revision precisely so a settings-only frame can land without
 * pretending the board changed. Bumping it here would mint a phantom generation:
 * the history strip would gain an entry for a mute, and `changedCellCount` would
 * have to be the only thing standing between a mute and a clack from 144 tiles.
 */
export const applySettings = (
  state: BoardRoomState,
  patch: BoardSettingsPatch
): BoardRoomState => ({
  ...state,
  ...(patch.soundPack === undefined ? {} : { soundPack: patch.soundPack }),
  ...(patch.muted === undefined ? {} : { muted: patch.muted }),
});

/**
 * Upper bound on a nonce presented to the ledger. Ours are 22 chars (128 bits of
 * base64url); the ceiling exists so a spend request can never write an unbounded
 * key into Durable Object storage.
 */
export const MAX_NONCE_LENGTH = 128;

/**
 * Longest life the ledger will remember a nonce for. A pairing token lives ~120s,
 * so an hour is already absurd headroom — the cap is here so a caller cannot ask
 * the room to keep a key effectively forever.
 */
export const MAX_NONCE_TTL_SECONDS = 3600;

export const SpendNonceRequest = Schema.Struct({
  nonce: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_NONCE_LENGTH)
  ),
  ttlSeconds: Schema.Number.pipe(
    Schema.int(),
    Schema.greaterThanOrEqualTo(1),
    Schema.lessThanOrEqualTo(MAX_NONCE_TTL_SECONDS)
  ),
});
export type SpendNonceRequest = typeof SpendNonceRequest.Type;

const decodeSpendNonceSchema = Schema.decodeUnknownEither(SpendNonceRequest);

/**
 * `null` on anything unparseable. The caller normalises its own TTL before
 * sending — a token with under a second left is clamped to 1, not rounded to 0 —
 * so a rejection here means a malformed request, never an ordinary expiry.
 */
export const parseSpendNonceRequest = (
  raw: string | ArrayBuffer
): SpendNonceRequest | null => {
  const text = decodeText(raw);
  if (text === null) return null;
  const parsed = Either.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => "invalid-json" as const,
  });
  if (Either.isLeft(parsed)) return null;
  const decoded = decodeSpendNonceSchema(parsed.right);
  return Either.isRight(decoded) ? decoded.right : null;
};

/** Storage key prefix for the spent-nonce ledger, so pruning can scan just those. */
export const NONCE_KEY_PREFIX = "nonce:";

export const nonceKey = (nonce: string): string => `${NONCE_KEY_PREFIX}${nonce}`;

/** The room's answer to a spend: did *this* call win the nonce? */
export const NonceSpendResult = Schema.Struct({
  type: Schema.Literal("nonce"),
  spent: Schema.Boolean,
});
export type NonceSpendResult = typeof NonceSpendResult.Type;

export const nonceSpendResult = (spent: boolean): NonceSpendResult => ({
  type: "nonce",
  spent,
});
