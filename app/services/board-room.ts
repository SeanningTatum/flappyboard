import { Context, Effect, Either, Layer } from "effect";
import { CloudflareEnv } from "./cloudflare";
import { ConfigurationError, ExternalServiceError } from "@/models/errors/repository";
import { decodeBoardGrid, type BoardGrid, type BoardMessage, type BoardSource } from "@/lib/schemas/board";
import {
  parseQuotaSpend,
  type QuotaEndpoint,
  type QuotaMode,
  type QuotaSpendResult,
} from "@/lib/board/quota";
import {
  deviceCodeRoomName,
  parseDeviceCodeApprove,
  parseDeviceCodeIssue,
  type DeviceCodeApproveOutcome,
} from "@/lib/board/device-code";
import {
  parseGrantRevoke,
  parseGrantTouch,
  parsePairedDevices,
  type PairedDeviceRecord,
} from "@/lib/board/paired-devices";

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

  /**
   * Atomically charge one call against the board's spend caps for a metered
   * endpoint. Answers whether the call may proceed, and how long to wait if not.
   *
   * Same reasoning as `spendNonce`: the counter lives in the board's Durable
   * Object because that is the only place a check-and-increment is serialised,
   * so N phones pressing the button together cannot lose increments to a race.
   * A broken ledger is a typed error, never a permissive `allowed: true` — the
   * caller fails closed, because an unmetered paid endpoint is the exact thing
   * this prevents.
   */
  readonly spendQuota: (
    params: SpendQuotaParams
  ) => Effect.Effect<QuotaSpendResult, ExternalServiceError>;

  /**
   * Claim a generated device code. `false` means the code was already taken —
   * the caller draws another rather than stealing a TV's pending pairing.
   *
   * Addressed by the code, not by a board: an unapproved code belongs to no
   * board yet, which is the whole reason it needs a room of its own.
   */
  readonly issueDeviceCode: (
    params: IssueDeviceCodeParams
  ) => Effect.Effect<boolean, ExternalServiceError>;

  /**
   * Consume a device code and push the (already minted) handoff to the TV
   * waiting on it. The outcome distinguishes a replay from a wrong code from an
   * expired one, so the owner is told something true.
   */
  readonly approveDeviceCode: (
    params: ApproveDeviceCodeParams
  ) => Effect.Effect<DeviceCodeApproveOutcome, ExternalServiceError>;

  /** Remember a freshly minted controller grant, with the name the phone typed. */
  readonly recordGrant: (
    params: RecordGrantParams
  ) => Effect.Effect<
    { readonly live: boolean; readonly name: string | null },
    ExternalServiceError
  >;

  /**
   * "Is this grant still one of ours?" plus the sliding renewal, in one call.
   * An unknown nonce answers `live: true` — see `decideTouch`.
   */
  readonly touchGrant: (
    params: TouchGrantParams
  ) => Effect.Effect<
    { readonly live: boolean; readonly name: string | null },
    ExternalServiceError
  >;

  /**
   * Set or replace the name on this device's own record — the phone labelling
   * itself after pairing. An unknown nonce (a phone paired before records
   * existed) has its record created by the same call; a tombstoned nonce
   * answers `live: false` and nothing is written. See `decideName`.
   */
  readonly nameGrant: (
    params: NameGrantParams
  ) => Effect.Effect<
    { readonly live: boolean; readonly name: string | null },
    ExternalServiceError
  >;

  /** Un-pair one device. `false` when the room held no record of it. */
  readonly revokeGrant: (
    boardId: string,
    nonce: string
  ) => Effect.Effect<boolean, ExternalServiceError>;

  /** Every paired device the owner can see, newest-seen first. */
  readonly listGrants: (
    boardId: string
  ) => Effect.Effect<ReadonlyArray<PairedDeviceRecord>, ExternalServiceError>;
}

export interface IssueDeviceCodeParams {
  readonly code: string;
  /** The secret that binds the approval frame to the socket that asked for it. */
  readonly watcher: string;
  readonly ttlSeconds: number;
}

export interface ApproveDeviceCodeParams {
  readonly code: string;
  readonly boardId: string;
  /**
   * A single-use `fbh1` token, minted by the caller. The room never signs
   * anything — keeping `BETTER_AUTH_SECRET` out of a code room means a guessed
   * code can never reach a credential-minting surface.
   */
  readonly handoff: string;
}

export interface RecordGrantParams {
  readonly boardId: string;
  /** The nonce inside the grant — the only identifier a phone cannot forge. */
  readonly nonce: string;
  readonly name: string | null;
  readonly ttlSeconds: number;
}

export interface TouchGrantParams {
  readonly boardId: string;
  readonly nonce: string;
  readonly ttlSeconds: number;
}

export interface NameGrantParams {
  readonly boardId: string;
  readonly nonce: string;
  /**
   * Already normalised by the caller (`normalizeDeviceName`) — the room bounds
   * the length but does not invent a name for a caller that skipped that step.
   */
  readonly name: string;
  /** The sliding window, same as a touch: naming a device proves it is alive. */
  readonly ttlSeconds: number;
}

export interface SpendQuotaParams {
  readonly boardId: string;
  readonly endpoint: QuotaEndpoint;
  /** `owner:<id>` or `grant:<nonce>` — see `spenderId` in `@/lib/board/quota`. */
  readonly spender: string;
  /**
   * `charge` to spend, `peek` to ask without spending.
   *
   * There is deliberately no `policy` field: the limits are the Durable Object's
   * to know, not its callers'. Passing them would make the cap a convention here
   * rather than a guarantee there.
   */
  readonly mode: QuotaMode;
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

    /**
     * One stub fetch against an instance addressed by name, decoded to
     * `unknown`. Non-200 is a typed failure.
     *
     * The name is usually a board id, but not always: a device code that has not
     * been approved yet belongs to no board, so it lives in an instance named
     * after the code itself. Same class, same storage discipline, disjoint
     * instance — see `deviceCodeRoomName`.
     */
    const rawCallNamed = (
      name: string,
      query: string,
      path: string,
      init?: RequestInit
    ): Effect.Effect<unknown, ExternalServiceError> =>
      Effect.gen(function* () {
        const url = `${ROOM_ORIGIN}${path}${query}`;
        const payload = yield* Effect.tryPromise({
          try: async () => {
            const stub = namespace.get(namespace.idFromName(name));
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

    /** The ordinary case: the instance is the board's own room. */
    const rawCall = (
      boardId: string,
      path: string,
      init?: RequestInit
    ): Effect.Effect<unknown, ExternalServiceError> =>
      rawCallNamed(
        boardId,
        `?boardId=${encodeURIComponent(boardId)}`,
        path,
        init
      );

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
      issueDeviceCode: (params: IssueDeviceCodeParams) =>
        Effect.gen(function* () {
          const body = yield* rawCallNamed(
            deviceCodeRoomName(params.code),
            "",
            "/device-code/issue",
            postJson({
              code: params.code,
              watcher: params.watcher,
              ttlSeconds: params.ttlSeconds,
            })
          );
          const issued = parseDeviceCodeIssue(body);
          if (issued === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised device-code payload",
              })
            );
          }
          return issued;
        }),
      approveDeviceCode: (params: ApproveDeviceCodeParams) =>
        Effect.gen(function* () {
          const body = yield* rawCallNamed(
            deviceCodeRoomName(params.code),
            "",
            "/device-code/approve",
            postJson({
              code: params.code,
              boardId: params.boardId,
              handoff: params.handoff,
            })
          );
          const outcome = parseDeviceCodeApprove(body);
          if (outcome === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised device-code payload",
              })
            );
          }
          return outcome;
        }),
      recordGrant: (params: RecordGrantParams) =>
        Effect.gen(function* () {
          const body = yield* rawCall(
            params.boardId,
            "/grants/record",
            postJson({
              nonce: params.nonce,
              name: params.name,
              ttlSeconds: params.ttlSeconds,
            })
          );
          const result = parseGrantTouch(body);
          if (result === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised paired-device payload",
              })
            );
          }
          return result;
        }),
      touchGrant: (params: TouchGrantParams) =>
        Effect.gen(function* () {
          const body = yield* rawCall(
            params.boardId,
            "/grants/touch",
            postJson({ nonce: params.nonce, ttlSeconds: params.ttlSeconds })
          );
          const result = parseGrantTouch(body);
          if (result === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised paired-device payload",
              })
            );
          }
          return result;
        }),
      nameGrant: (params: NameGrantParams) =>
        Effect.gen(function* () {
          const body = yield* rawCall(
            params.boardId,
            "/grants/name",
            postJson({
              nonce: params.nonce,
              name: params.name,
              ttlSeconds: params.ttlSeconds,
            })
          );
          const result = parseGrantTouch(body);
          if (result === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised paired-device payload",
              })
            );
          }
          return result;
        }),
      revokeGrant: (boardId: string, nonce: string) =>
        Effect.gen(function* () {
          const body = yield* rawCall(
            boardId,
            "/grants/revoke",
            postJson({ nonce })
          );
          const revoked = parseGrantRevoke(body);
          if (revoked === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised paired-device payload",
              })
            );
          }
          return revoked;
        }),
      listGrants: (boardId: string) =>
        Effect.gen(function* () {
          const body = yield* rawCall(boardId, "/grants");
          const devices = parsePairedDevices(body);
          if (devices === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised paired-device payload",
              })
            );
          }
          return devices;
        }),
      spendQuota: (params: SpendQuotaParams) =>
        Effect.gen(function* () {
          const body = yield* rawCall(
            params.boardId,
            "/spend-quota",
            postJson({
              endpoint: params.endpoint,
              spender: params.spender,
              mode: params.mode,
            })
          );
          const result = parseQuotaSpend(body);
          if (result === null) {
            return yield* Effect.fail(
              new ExternalServiceError({
                service: "BoardRoom",
                cause: "room returned an unrecognised quota-ledger payload",
              })
            );
          }
          return result;
        }),
    };
  })
);
