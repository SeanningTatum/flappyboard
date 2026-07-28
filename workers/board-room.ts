import { DurableObject } from "cloudflare:workers";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { and, eq, sql } from "drizzle-orm";
import { Cause, Effect, Either, Exit } from "effect";
import * as schema from "@/db/schema";
import { board, boardSnapshot } from "@/db/schema";
import { loggers } from "@/lib/logger";
import {
  applySet,
  applySettings,
  decodeRoomState,
  errorEvent,
  initialState,
  nonceKey,
  nonceSpendResult,
  parseCommand,
  parseSettingsPatch,
  parseSpendNonceRequest,
  serializeEvent,
  stateEvent,
  NONCE_KEY_PREFIX,
  type BoardRoomState,
  type SetCommand,
} from "@/lib/board/protocol";
import {
  boardQuotaKey,
  decideQuota,
  parseSpendQuotaRequest,
  quotaSpendResult,
  readCount,
  spenderQuotaKey,
  windowStart,
  QUOTA_KEY_PREFIX,
  type QuotaEntry,
} from "@/lib/board/quota";

const STATE_KEY = "board:state";
const BOARD_ID_KEY = "board:id";

/**
 * How many ledger keys one prune pass will look at. A pairing token lives ~120s,
 * so the live set is tiny in any realistic use; the bound exists so a room that
 * somehow accumulated thousands of keys prunes them across several spends
 * instead of stalling one request (and the object's input gate with it).
 */
const NONCE_PRUNE_LIMIT = 256;

/**
 * Same bound, same reason, for the quota counters. The live set is at most two
 * keys per spender per endpoint per window, so in practice this never binds —
 * it is here so a room that somehow accumulated thousands of dead counters
 * prunes them across several spends instead of stalling one request.
 */
const QUOTA_PRUNE_LIMIT = 256;

const log = loggers.server.child({ component: "board-room" });

/**
 * One live board = one Durable Object. It owns the authoritative `{ revision,
 * grid, soundPack, muted }` state, fans every applied write out to every
 * connected screen, and mirrors each write into D1 as a snapshot row.
 *
 * Sockets are accepted through the **WebSocket Hibernation API**
 * (`ctx.acceptWebSocket` + `webSocket*` handlers) rather than an in-memory
 * `addEventListener` loop: an idle board hibernates and costs nothing, and the
 * socket set survives eviction because the runtime — not this class — holds it.
 * That is also why state lives in `ctx.storage` and never only in a field.
 *
 * All decision logic lives in `app/lib/board/protocol.ts` (pure, unit-tested).
 * This file is deliberately thin platform glue; the only `async` here is the
 * platform's own, and every fallible promise goes through Effect.
 */
export class BoardRoom extends DurableObject<Env> {
  /** Write-through cache of the storage row — never the source of truth. */
  private state: BoardRoomState = initialState();
  private boardId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Nothing may observe a half-loaded room, so hydration blocks the object's
    // input gate instead of racing the first request. A read failure leaves the
    // blank initial state rather than escaping and destroying the object.
    void this.ctx.blockConcurrencyWhile(async () => {
      const hydrated = await Effect.runPromise(
        Effect.either(
          Effect.tryPromise(async () => ({
            state: await this.ctx.storage.get<unknown>(STATE_KEY),
            boardId: await this.ctx.storage.get<string>(BOARD_ID_KEY),
          }))
        )
      );

      if (Either.isLeft(hydrated)) {
        log.error({ err: hydrated.left }, "Failed to hydrate board room state");
        return;
      }

      this.state = decodeRoomState(hydrated.right.state) ?? initialState();
      const id = hydrated.right.boardId;
      this.boardId = typeof id === "string" && id.length > 0 ? id : null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    await this.rememberBoardId(url.searchParams.get("boardId"));

    if (request.method === "GET" && url.pathname === "/ws") {
      return this.openSocket(request);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      return BoardRoom.json(stateEvent(this.state));
    }

    if (request.method === "POST" && url.pathname === "/set") {
      return this.handleSet(request);
    }

    if (request.method === "POST" && url.pathname === "/settings") {
      return this.handleSettings(request);
    }

    if (request.method === "POST" && url.pathname === "/spend-nonce") {
      return this.handleSpendNonce(request);
    }

    if (request.method === "POST" && url.pathname === "/spend-quota") {
      return this.handleSpendQuota(request);
    }

    return new Response("Not Found", { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  private openSocket(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    // A screen must be able to render immediately, before anyone writes.
    BoardRoom.send(server, serializeEvent(stateEvent(this.state)));

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleSet(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const command = parseCommand(body.right);
    if (command === null || command.type !== "set") {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    return BoardRoom.json(await this.applyAndBroadcast(command, null));
  }

  /**
   * `soundPack` / `muted` for this room, pushed in by `board.updateSettings`
   * after the D1 write. D1 stays the durable record; the room is what the TV
   * reads, so both have to move or the TV keeps the old pack until the next grid
   * write.
   *
   * The broadcast carries the **same revision** — see `applySettings`. That is
   * exactly why `shouldApplyState` applies equal revisions on the client.
   */
  private async handleSettings(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const patch = parseSettingsPatch(body.right);
    if (patch === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const state = applySettings(this.state, patch);
    this.state = state;

    const persisted = await Effect.runPromiseExit(
      Effect.tryPromise(() => this.ctx.storage.put(STATE_KEY, state))
    );
    if (Exit.isFailure(persisted)) {
      log.error(
        { cause: Cause.pretty(persisted.cause), revision: state.revision },
        "Failed to persist board settings to DO storage"
      );
    }

    // No snapshot row: history is a log of *grids*, and a mute is not a grid.
    const event = stateEvent(state);
    const payload = serializeEvent(event);
    for (const socket of this.ctx.getWebSockets()) {
      BoardRoom.send(socket, payload);
    }

    return BoardRoom.json(event);
  }

  /**
   * The spent-nonce ledger for single-use pairing tokens.
   *
   * This lives here rather than in the request worker because the room is the one
   * place where check-and-set is genuinely atomic: one Durable Object per board id,
   * single-threaded, and `blockConcurrencyWhile` additionally holds the input gate
   * shut for the whole read → decide → write, so two redemptions of the same token
   * arriving together are serialised and exactly one sees an empty slot.
   *
   * Answers `{ type: "nonce", spent }` — `spent: true` means *this* call is the one
   * that consumed the nonce. Any storage failure is a 500, which the caller treats
   * as a refusal (fail closed).
   */
  private async handleSpendNonce(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const spend = parseSpendNonceRequest(body.right);
    if (spend === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const key = nonceKey(spend.nonce);
    const expiresAt = now + spend.ttlSeconds * 1000;

    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          await this.pruneNonces(now);
          // Presence alone refuses. Pruning is the only thing that removes a
          // key, so anything still here is either live or younger than one
          // prune pass — either way, refusing is the fail-closed answer.
          const seen = await this.ctx.storage.get<number>(key);
          if (seen !== undefined) return false;
          await this.ctx.storage.put(key, expiresAt);
          return true;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Nonce ledger failed — refusing the pairing"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(nonceSpendResult(outcome.value));
  }

  /**
   * Drop ledger entries whose recorded expiry has passed, so a board paired twice
   * a day for a year does not carry 700 dead keys. Runs inside the same
   * `blockConcurrencyWhile` as the spend it precedes — no extra gate, no separate
   * alarm to keep alive.
   */
  private async pruneNonces(now: number): Promise<void> {
    const entries = await this.ctx.storage.list<number>({
      prefix: NONCE_KEY_PREFIX,
      limit: NONCE_PRUNE_LIMIT,
    });
    const dead: string[] = [];
    for (const [key, value] of entries) {
      if (typeof value !== "number" || value <= now) dead.push(key);
    }
    if (dead.length > 0) await this.ctx.storage.delete(dead);
  }

  /**
   * Spend caps for the two endpoints that cost money — `board.generate` and
   * `/api/transcribe`.
   *
   * Here for the same reason the nonce ledger is: the room is the only place
   * where read → decide → write is genuinely atomic, so N phones hammering the
   * button together are serialised and the counter cannot be lost to a race. No
   * new binding, no KV round trip, no alarm.
   *
   * Two buckets are checked and a call must clear both — the spender's own
   * allowance (keyed by the nonce inside its grant, so one guest cannot eat
   * another's) and the board's ceiling (so re-pairing for a fresh nonce buys
   * nothing). The decision itself is pure and lives in `@/lib/board/quota`; this
   * method is storage glue.
   *
   * Answers `{ type: "quota", allowed, retryAfter }`. Any storage failure is a
   * 500, which the caller treats as a refusal (fail closed) — an unmetered
   * endpoint is exactly what this exists to prevent.
   */
  private async handleSpendQuota(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const spend = parseSpendQuotaRequest(body.right);
    if (spend === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const start = windowStart(now, spend.windowSeconds);
    const expiresAt = start + spend.windowSeconds * 1000;
    const sKey = spenderQuotaKey(spend.endpoint, spend.spender, start);
    const bKey = boardQuotaKey(spend.endpoint, start);

    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          await this.pruneQuotas(now);

          const decision = decideQuota({
            spenderCount: readCount(await this.ctx.storage.get(sKey)),
            boardCount: readCount(await this.ctx.storage.get(bKey)),
            spenderLimit: spend.spenderLimit,
            boardLimit: spend.boardLimit,
            now,
            windowSeconds: spend.windowSeconds,
          });

          // A refusal writes nothing: counting refused calls would let a caller
          // who is already over the limit hold the board bucket down on traffic
          // that never cost anything.
          if (decision.allowed) {
            const sEntry: QuotaEntry = {
              count: decision.spenderCount,
              expiresAt,
            };
            const bEntry: QuotaEntry = { count: decision.boardCount, expiresAt };
            await this.ctx.storage.put({ [sKey]: sEntry, [bKey]: bEntry });
          }

          return decision;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Quota ledger failed — refusing the spend"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(
      quotaSpendResult(outcome.value.allowed, outcome.value.retryAfter)
    );
  }

  /**
   * Drop counters whose window has closed. Runs inside the same
   * `blockConcurrencyWhile` as the spend it precedes, exactly like
   * `pruneNonces` — no extra gate, no alarm to keep alive.
   */
  private async pruneQuotas(now: number): Promise<void> {
    const entries = await this.ctx.storage.list<unknown>({
      prefix: QUOTA_KEY_PREFIX,
      limit: QUOTA_PRUNE_LIMIT,
    });
    const dead: string[] = [];
    for (const [key, value] of entries) {
      // An unreadable counter is collected too: `readCount` already treats it as
      // zero, so leaving it would only keep a permanently-ignored key around.
      const entry = value as Partial<QuotaEntry> | null;
      const expiresAt =
        typeof entry?.expiresAt === "number" ? entry.expiresAt : 0;
      if (expiresAt <= now) dead.push(key);
    }
    if (dead.length > 0) await this.ctx.storage.delete(dead);
  }

  // -------------------------------------------------------------------------
  // Hibernation handlers
  // -------------------------------------------------------------------------

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    const command = parseCommand(message);

    if (command === null) {
      BoardRoom.send(ws, serializeEvent(errorEvent("invalid_command")));
      return;
    }

    if (command.type === "hello") {
      BoardRoom.send(ws, serializeEvent(stateEvent(this.state)));
      return;
    }

    await this.applyAndBroadcast(command, ws);
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    log.debug({ code, reason, wasClean }, "Board socket closed");
    // 1006 is reserved and cannot be echoed back to the peer.
    BoardRoom.close(ws, code === 1006 ? 1000 : code, reason);
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    log.warn({ err: error }, "Board socket error");
  }

  // -------------------------------------------------------------------------
  // Write path
  // -------------------------------------------------------------------------

  /**
   * The live update wins over durability: memory and DO storage first, then the
   * fan-out, then D1. A failed snapshot is reported, never fatal — a board that
   * stops updating because history could not be written is strictly worse than
   * a gap in history.
   */
  private async applyAndBroadcast(
    command: SetCommand,
    origin: WebSocket | null
  ) {
    const { state, truncated } = applySet(this.state, command);
    this.state = state;

    const persisted = await Effect.runPromiseExit(
      Effect.tryPromise(() => this.ctx.storage.put(STATE_KEY, state))
    );
    if (Exit.isFailure(persisted)) {
      log.error(
        { cause: Cause.pretty(persisted.cause), revision: state.revision },
        "Failed to persist board state to DO storage"
      );
    }

    const event = stateEvent(state, truncated);
    const payload = serializeEvent(event);
    for (const socket of this.ctx.getWebSockets()) {
      BoardRoom.send(socket, payload);
    }

    await this.persistSnapshot(state, command, origin);
    return event;
  }

  private async persistSnapshot(
    state: BoardRoomState,
    command: SetCommand,
    origin: WebSocket | null
  ): Promise<void> {
    const boardId = this.boardId;
    if (boardId === null) {
      log.warn(
        { revision: state.revision },
        "No boardId known for this room — skipping snapshot"
      );
      return;
    }

    const db = drizzleD1(this.env.DATABASE, { schema, logger: false });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          db
            .insert(boardSnapshot)
            .values({
              id: crypto.randomUUID(),
              boardId,
              revision: state.revision,
              cells: JSON.stringify(state.grid),
              source: command.source ?? "manual",
              prompt: command.prompt ?? null,
            })
            .run()
        );

        // The room, not D1, is the authority on live state — but `board.revision`
        // exists so a cold read (or a future automation) can tell how far the
        // board has advanced without waking the room. Bump it monotonically, the
        // same way BoardRepository.saveSnapshot does, so a late-arriving older
        // write can never move it backwards.
        yield* Effect.tryPromise(() =>
          db
            .update(board)
            .set({ revision: state.revision, updatedAt: new Date() })
            .where(
              and(
                eq(board.id, boardId),
                sql`${board.revision} < ${state.revision}`
              )
            )
            .run()
        );
      })
    );

    if (Exit.isFailure(exit)) {
      log.error(
        {
          cause: Cause.pretty(exit.cause),
          boardId,
          revision: state.revision,
        },
        "Failed to persist board snapshot"
      );
      if (origin !== null) {
        BoardRoom.send(origin, serializeEvent(errorEvent("persist_failed")));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** First caller to name the board wins; later requests may omit the param. */
  private async rememberBoardId(candidate: string | null): Promise<void> {
    if (candidate === null || candidate.length === 0) return;
    if (this.boardId === candidate) return;
    this.boardId = candidate;
    const stored = await Effect.runPromiseExit(
      Effect.tryPromise(() => this.ctx.storage.put(BOARD_ID_KEY, candidate))
    );
    if (Exit.isFailure(stored)) {
      log.error(
        { cause: Cause.pretty(stored.cause), boardId: candidate },
        "Failed to persist boardId"
      );
    }
  }

  /**
   * A socket the runtime still lists can already be gone; a throw here would
   * abort the fan-out mid-broadcast, so failures are swallowed per socket.
   */
  private static send(ws: WebSocket, payload: string): void {
    Effect.runSync(Effect.ignore(Effect.try(() => ws.send(payload))));
  }

  private static close(ws: WebSocket, code: number, reason: string): void {
    Effect.runSync(Effect.ignore(Effect.try(() => ws.close(code, reason))));
  }

  private static json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
}
