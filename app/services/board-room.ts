import { Context, Effect, Either, Layer } from "effect";
import { CloudflareEnv } from "./cloudflare";
import { ConfigurationError, ExternalServiceError } from "@/models/errors/repository";
import { decodeBoardGrid, type BoardGrid, type BoardMessage, type BoardSource } from "@/lib/schemas/board";

/**
 * The live state of a board as the room reports it. Declared structurally
 * rather than imported from the room's protocol module so the request-side
 * service and the Durable Object stay decoupled — the wire shape is the
 * contract, not a shared class.
 */
export interface BoardRoomState {
  readonly revision: number;
  readonly grid: BoardGrid;
  readonly soundPack: string;
  readonly muted: boolean;
  readonly truncated: boolean;
}

export interface SetBoardMessageParams {
  readonly boardId: string;
  readonly baseRevision: number;
  readonly message: BoardMessage;
  readonly source?: BoardSource;
  readonly prompt?: string;
}

export interface UpdateRoomSettingsParams {
  readonly boardId: string;
  /** Absent means "leave it alone" — not "reset to the default". */
  readonly soundPack?: string;
  readonly muted?: boolean;
}

export interface BoardRoomShape {
  readonly getState: (
    boardId: string
  ) => Effect.Effect<BoardRoomState, ExternalServiceError>;
  readonly setMessage: (
    params: SetBoardMessageParams
  ) => Effect.Effect<BoardRoomState, ExternalServiceError>;
  /**
   * Push `soundPack` / `muted` into the room and have it broadcast a `state`
   * frame **at the same revision**, so the TV applies the new settings without a
   * phantom grid generation appearing in history.
   */
  readonly updateSettings: (
    params: UpdateRoomSettingsParams
  ) => Effect.Effect<BoardRoomState, ExternalServiceError>;
  /**
   * Atomically record a pairing nonce as spent. `true` when *this* call was the
   * one that spent it, `false` when it was already gone.
   *
   * The ledger lives in the board's Durable Object: one object per board id,
   * single-threaded, and the check-and-set runs under `blockConcurrencyWhile`, so
   * two concurrent redemptions of one token cannot both win. Any failure is a
   * typed error rather than a `false`, so the caller can fail closed without
   * having to guess which of "already spent" and "ledger broken" it is looking at.
   */
  readonly spendNonce: (
    boardId: string,
    nonce: string,
    ttlSeconds: number
  ) => Effect.Effect<boolean, ExternalServiceError>;
}

export class BoardRoom extends Context.Tag("app/BoardRoom")<
  BoardRoom,
  BoardRoomShape
>() {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The room is trusted but not assumed — a shape change or an error event
 * surfaces as a typed failure instead of `undefined` leaking into the UI.
 * Pure and total so it can be tested without a Durable Object.
 */
export const parseRoomState = (payload: unknown): BoardRoomState | null => {
  if (!isRecord(payload)) return null;
  if (payload.type !== "state") return null;
  if (typeof payload.revision !== "number" || !Number.isInteger(payload.revision)) {
    return null;
  }
  if (typeof payload.soundPack !== "string" || typeof payload.muted !== "boolean") {
    return null;
  }
  const grid = decodeBoardGrid(payload.grid);
  if (Either.isLeft(grid)) return null;
  return {
    revision: payload.revision,
    grid: grid.right,
    soundPack: payload.soundPack,
    muted: payload.muted,
    truncated: payload.truncated === true,
  };
};

/**
 * The room's answer to a nonce spend. Same discipline as `parseRoomState`: a
 * missing or non-boolean `spent` is *not* read as `false` — it returns `null` so
 * the caller raises a typed error, because silently treating an unrecognised
 * answer as "already spent" would turn a shape mismatch into a pairing outage
 * that looks exactly like a replay.
 */
export const parseNonceSpend = (payload: unknown): boolean | null => {
  if (!isRecord(payload)) return null;
  if (payload.type !== "nonce") return null;
  return typeof payload.spent === "boolean" ? payload.spent : null;
};

/** DO stub fetches need an absolute URL; the host is arbitrary and never resolved. */
const ROOM_ORIGIN = "https://board-room.internal";

export const BoardRoomLive = Layer.effect(
  BoardRoom,
  Effect.gen(function* () {
    const env = yield* CloudflareEnv;
    // Mirrors BucketLive / WorkflowsLive: the binding can be absent from a
    // deployment even when the generated Env type says otherwise, so fail with
    // a typed ConfigurationError rather than a TypeError deep in a fetch.
    const namespace = (
      env as Env & { BOARD?: DurableObjectNamespace }
    ).BOARD;
    if (!namespace) {
      return yield* Effect.fail(
        new ConfigurationError({ service: "BoardRoom", field: "BOARD" })
      );
    }

    /** One stub fetch, decoded to `unknown`. Non-200 is a typed failure. */
    const rawCall = (
      boardId: string,
      path: string,
      init?: RequestInit
    ): Effect.Effect<unknown, ExternalServiceError> =>
      Effect.gen(function* () {
        const url = `${ROOM_ORIGIN}${path}?boardId=${encodeURIComponent(boardId)}`;
        const payload = yield* Effect.tryPromise({
          try: async () => {
            const stub = namespace.get(namespace.idFromName(boardId));
            const response = await stub.fetch(url, init);
            if (!response.ok) {
              return { status: response.status, body: await response.text() };
            }
            return { status: response.status, body: await response.json() };
          },
          catch: (cause) =>
            new ExternalServiceError({ service: "BoardRoom", cause }),
        });

        if (payload.status !== 200) {
          return yield* Effect.fail(
            new ExternalServiceError({
              service: "BoardRoom",
              cause: `room responded ${payload.status}: ${String(payload.body)}`,
            })
          );
        }

        return payload.body;
      });

    const call = (
      boardId: string,
      path: string,
      init?: RequestInit
    ): Effect.Effect<BoardRoomState, ExternalServiceError> =>
      Effect.gen(function* () {
        const body = yield* rawCall(boardId, path, init);
        const state = parseRoomState(body);
        if (state === null) {
          return yield* Effect.fail(
            new ExternalServiceError({
              service: "BoardRoom",
              cause: "room returned an unrecognised state payload",
            })
          );
        }
        return state;
      });

    const postJson = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    return {
      getState: (boardId: string) => call(boardId, "/state"),
      setMessage: (params: SetBoardMessageParams) =>
        call(
          params.boardId,
          "/set",
          postJson({
            type: "set",
            baseRevision: params.baseRevision,
            message: params.message,
            source: params.source,
            prompt: params.prompt,
          })
        ),
      updateSettings: (params: UpdateRoomSettingsParams) =>
        call(
          params.boardId,
          "/settings",
          // Only the keys that were actually asked for: the room reads an absent
          // field as "leave it alone", and `JSON.stringify` drops `undefined`, so
          // a mute-only change never resets the pack.
          postJson({
            soundPack: params.soundPack,
            muted: params.muted,
          })
        ),
      spendNonce: (boardId: string, nonce: string, ttlSeconds: number) =>
        Effect.gen(function* () {
          const body = yield* rawCall(
            boardId,
            "/spend-nonce",
            postJson({ nonce, ttlSeconds })
          );
          const spent = parseNonceSpend(body);
          if (spent === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised nonce-ledger payload",
              })
            );
          }
          return spent;
        }),
    };
  })
);
