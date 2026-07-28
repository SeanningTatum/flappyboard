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
  decodeDeviceCodeRecord,
  deviceCodeApproveResult,
  deviceCodeIssueResult,
  isDeviceCodeLive,
  parseApproveDeviceCodeRequest,
  parseIssueDeviceCodeRequest,
  DEVICE_CODE_KEY,
  type DeviceCodeRecord,
} from "@/lib/board/device-code";
import {
  decideTouch,
  decodePairedDevice,
  grantKey,
  grantRevokeResult,
  grantTouchResult,
  normalizeDeviceName,
  overflowVictims,
  pairedDeviceList,
  parseRecordGrantRequest,
  parseRevokeGrantRequest,
  parseTouchGrantRequest,
  pruneDevices,
  renewRecord,
  revokedKey,
  GRANT_KEY_PREFIX,
  MAX_PAIRED_DEVICES,
  REVOKED_KEY_PREFIX,
  type PairedDeviceRecord,
} from "@/lib/board/paired-devices";
import { timingSafeEqual } from "@/lib/board/pairing";
import {
  boardQuotaKey,
  decideQuota,
  isQuotaEntry,
  parseSpendQuotaRequest,
  quotaSpendResult,
  readCount,
  spenderQuotaKey,
  windowStart,
  DEFAULT_QUOTA,
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

/** Same bound, same reason, for the per-grant device records. */
const GRANT_PRUNE_LIMIT = 256;

/**
 * Tombstone left behind when a device code is redeemed, so a replay can be
 * answered `already-approved` instead of `unknown`. It lives exactly as long as
 * the code would have, then prunes itself — the distinction only matters while
 * somebody could still be holding the code.
 */
const DEVICE_CODE_CONSUMED_KEY = "device-code:consumed";

/**
 * The tag every TV socket waiting on a device code is accepted under.
 *
 * Two socket populations share this class because a pending code has no board
 * yet and therefore lives in its own instance (`code:<CODE>` — see
 * `deviceCodeRoomName`). The tag keeps them apart in the hibernation handlers:
 * a waiting TV must never be handed a board `state` frame, and a board write
 * must never be fanned out to one.
 */
const DEVICE_CODE_TAG = "device-code";

/**
 * How long a revocation tombstone survives when the room has no record of the
 * grant being revoked — the 400-day `Max-Age` ceiling a browser will honour,
 * which is the longest any grant cookie could still be presented for. Erring
 * long is the only safe direction: a tombstone that expires early silently
 * un-revokes the device it was written to stop.
 */
const MAX_GRANT_TOMBSTONE_MS = 400 * 24 * 60 * 60 * 1000;

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

    if (request.method === "POST" && url.pathname === "/device-code/issue") {
      return this.handleIssueDeviceCode(request);
    }

    if (request.method === "GET" && url.pathname === "/device-code/watch") {
      return this.openDeviceCodeSocket(request, url);
    }

    if (request.method === "POST" && url.pathname === "/device-code/approve") {
      return this.handleApproveDeviceCode(request);
    }

    if (request.method === "POST" && url.pathname === "/grants/record") {
      return this.handleRecordGrant(request);
    }

    if (request.method === "POST" && url.pathname === "/grants/touch") {
      return this.handleTouchGrant(request);
    }

    if (request.method === "POST" && url.pathname === "/grants/revoke") {
      return this.handleRevokeGrant(request);
    }

    if (request.method === "GET" && url.pathname === "/grants") {
      return this.handleListGrants();
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
   * **The policy is read here, not received.** The request body carries only
   * `endpoint`, `spender` and `mode`; the limits come from `DEFAULT_QUOTA`. An
   * earlier version took the limits off the wire, which meant the object enforced
   * whatever its caller asked for — so a future call site that forgot to pass
   * `DEFAULT_QUOTA` would have quietly got its own numbers, and the cap would have
   * been a convention rather than something this object guarantees.
   *
   * `mode: "peek"` decides without writing, for a caller that needs to refuse an
   * over-cap request before doing expensive work it would then have to throw away.
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

    const policy = DEFAULT_QUOTA[spend.endpoint];
    const now = Date.now();
    const start = windowStart(now, policy.windowSeconds);
    const expiresAt = start + policy.windowSeconds * 1000;
    const sKey = spenderQuotaKey(spend.endpoint, spend.spender, start);
    const bKey = boardQuotaKey(spend.endpoint, start);

    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          await this.pruneQuotas(now);

          const sRaw = await this.ctx.storage.get(sKey);
          const bRaw = await this.ctx.storage.get(bKey);

          // `readCount` treats an unreadable slot as zero, which fails *open* —
          // deliberate, because bricking a family's board over corrupt
          // bookkeeping is worse than letting a window's worth of calls
          // through, and the other bucket still bounds the damage. But silent
          // is not acceptable: on the board bucket a reset briefly removes the
          // ceiling that blocks the re-pairing bypass, so it gets said out loud.
          for (const [label, raw] of [
            ["spender", sRaw],
            ["board", bRaw],
          ] as const) {
            if (raw !== undefined && !isQuotaEntry(raw)) {
              log.warn(
                { bucket: label, endpoint: spend.endpoint },
                "Quota counter unreadable — treated as zero for this window"
              );
            }
          }

          const decision = decideQuota({
            spenderCount: readCount(sRaw),
            boardCount: readCount(bRaw),
            spenderLimit: policy.spenderLimit,
            boardLimit: policy.boardLimit,
            now,
            windowSeconds: policy.windowSeconds,
          });

          // A refusal writes nothing: counting refused calls would let a caller
          // who is already over the limit hold the board bucket down on traffic
          // that never cost anything. A peek writes nothing either, by
          // definition — it is a question, not a spend.
          if (decision.allowed && spend.mode === "charge") {
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
  // Device codes — the TV's half of pairing
  // -------------------------------------------------------------------------

  /**
   * Claim a freshly generated 6-character code for this room.
   *
   * **Which room?** Not a board's. A code exists precisely because no board has
   * been chosen yet, so it lives in an instance addressed by the code itself
   * (`idFromName("code:" + CODE)`, see `deviceCodeRoomName`). That is what lets
   * the TV's socket and the owner's approval — two requests that share nothing
   * but six characters typed across a room — land on the same single-threaded
   * object without a global registry to serialise every pairing in the
   * deployment through one hot spot.
   *
   * The code is generated in the worker and *claimed* here rather than minted
   * here, so a collision is a fact this object can refuse rather than a race the
   * caller has to detect: a second TV that draws a live code is told
   * `issued: false` under `blockConcurrencyWhile` and simply draws another.
   *
   * `watcher` is the secret that makes the code safe to use as an address.
   * Without it, anyone who guessed a code could hold a socket on this instance
   * and be handed the approval frame meant for the real TV — the code alone
   * decides *where* you connect, never *whether* you are the one who asked.
   */
  private async handleIssueDeviceCode(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const issue = parseIssueDeviceCodeRequest(body.right);
    if (issue === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const record: DeviceCodeRecord = {
      code: issue.code,
      watcher: issue.watcher,
      issuedAt: now,
      expiresAt: now + issue.ttlSeconds * 1000,
    };

    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          const existing = decodeDeviceCodeRecord(
            await this.ctx.storage.get(DEVICE_CODE_KEY)
          );
          // A live code is never overwritten: the TV already showing it would
          // silently stop being the one that gets approved.
          if (existing !== null && isDeviceCodeLive(existing, now)) return false;

          const consumed = await this.ctx.storage.get<number>(
            DEVICE_CODE_CONSUMED_KEY
          );
          // Nor is one that was just redeemed — reusing it inside its own
          // lifetime would make a replay indistinguishable from a fresh code.
          if (typeof consumed === "number" && consumed > now) return false;

          await this.ctx.storage.put(DEVICE_CODE_KEY, record);
          return true;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Device-code store failed — refusing to issue"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(deviceCodeIssueResult(outcome.value));
  }

  /**
   * The TV's waiting socket.
   *
   * It exists so approval arrives as a push rather than a poll — the board
   * appears the instant the owner taps, with no reload — and it doubles as the
   * liveness signal that lets `webSocketClose` expire a code whose TV walked
   * away.
   *
   * The `watcher` presented here is compared in constant time against the one
   * banked at issue. Every refusal is an identical 404: a caller who guessed a
   * live code must not be able to tell it apart from one that was never issued,
   * or the socket becomes an oracle for exactly the thing the code protects.
   */
  private async openDeviceCodeSocket(
    request: Request,
    url: URL
  ): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const watcher = url.searchParams.get("watcher") ?? "";
    const stored = await Effect.runPromise(
      Effect.either(
        Effect.tryPromise(() => this.ctx.storage.get(DEVICE_CODE_KEY))
      )
    );
    if (Either.isLeft(stored)) {
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    const record = decodeDeviceCodeRecord(stored.right);
    const encoder = new TextEncoder();
    if (
      record === null ||
      !isDeviceCodeLive(record, Date.now()) ||
      !timingSafeEqual(encoder.encode(record.watcher), encoder.encode(watcher))
    ) {
      return new Response("Not found", { status: 404 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [DEVICE_CODE_TAG]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Consume a code and push the handoff to the TV waiting on it.
   *
   * Single-use is the same guarantee the pairing nonce already has and it is
   * enforced the same way: read → decide → write inside
   * `blockConcurrencyWhile`, so six simultaneous redemptions of one code
   * produce exactly one `approved` and five refusals.
   *
   * The room signs nothing. `handoff` arrives already minted by the worker,
   * which is where the owner's session was checked and where the board row —
   * and therefore `deviceEpoch` — was read. Keeping `BETTER_AUTH_SECRET` out of
   * this object means a code room can never mint a credential of its own.
   *
   * The redeemed code leaves a tombstone rather than vanishing, so a replay is
   * answered `already-approved` instead of `unknown` for as long as anyone could
   * still be holding it.
   */
  private async handleApproveDeviceCode(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const approve = parseApproveDeviceCodeRequest(body.right);
    if (approve === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          const record = decodeDeviceCodeRecord(
            await this.ctx.storage.get(DEVICE_CODE_KEY)
          );

          if (record === null) {
            const consumed = await this.ctx.storage.get<number>(
              DEVICE_CODE_CONSUMED_KEY
            );
            if (typeof consumed === "number" && consumed > now) {
              return "already-approved" as const;
            }
            return "unknown" as const;
          }

          if (!isDeviceCodeLive(record, now)) {
            await this.ctx.storage.delete(DEVICE_CODE_KEY);
            return "expired" as const;
          }

          // The code presented has to be the code stored. It always is when the
          // room was addressed by name, so this is defence in depth against a
          // future call site that reaches a room some other way.
          if (record.code !== approve.code) return "unknown" as const;

          await this.ctx.storage.delete(DEVICE_CODE_KEY);
          await this.ctx.storage.put(
            DEVICE_CODE_CONSUMED_KEY,
            record.expiresAt
          );
          return "approved" as const;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Device-code ledger failed — refusing the approval"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    // Only after the gate has closed, and only for the call that won it. A frame
    // sent on any other path would hand a handoff to a TV whose code was not
    // actually consumed.
    if (outcome.value === "approved") {
      const frame = JSON.stringify({
        type: "approved",
        boardId: approve.boardId,
        handoff: approve.handoff,
      });
      for (const socket of this.ctx.getWebSockets(DEVICE_CODE_TAG)) {
        BoardRoom.send(socket, frame);
      }
    }

    return BoardRoom.json(deviceCodeApproveResult(outcome.value));
  }

  // -------------------------------------------------------------------------
  // Paired devices — per-grant records
  // -------------------------------------------------------------------------

  /**
   * Remember a grant that was just minted, with the name the phone typed.
   *
   * This is what turns revocation from "bump the epoch and make the whole house
   * re-scan" into "un-pair Kai's phone". The record is bookkeeping only: it
   * never authorises anything on its own, and a grant's *validity* remains the
   * signed token's business.
   */
  private async handleRecordGrant(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const input = parseRecordGrantRequest(body.right);
    if (input === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          await this.pruneGrants(now);
          const key = grantKey(input.nonce);
          const existing = decodePairedDevice(await this.ctx.storage.get(key));
          const record = renewRecord({
            record: existing,
            nonce: input.nonce,
            name: normalizeDeviceName(input.name),
            now,
            ttlSeconds: input.ttlSeconds,
          });
          await this.ctx.storage.put(key, record);
          await this.enforceDeviceLimit();
          return record;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Paired-device record failed"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(
      grantTouchResult(true, outcome.value.name)
    );
  }

  /**
   * "Is this grant still one of ours?", asked on every authorised request, and
   * the place the sliding renewal is recorded.
   *
   * **An unknown nonce is live.** Every phone paired before per-device records
   * existed holds a perfectly valid signed grant and has no record here, so
   * reading absence as revocation would un-pair the entire house on deploy.
   * Revocation is an explicit tombstone; see `decideTouch`, which owns that
   * decision and is unit-tested away from this glue.
   */
  private async handleTouchGrant(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const input = parseTouchGrantRequest(body.right);
    if (input === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          const key = grantKey(input.nonce);
          const record = decodePairedDevice(await this.ctx.storage.get(key));
          const tombstone = await this.ctx.storage.get<number>(
            revokedKey(input.nonce)
          );
          const decision = decideTouch({
            record,
            revoked: typeof tombstone === "number",
            now,
          });

          // Only a live grant moves its own expiry forward. Touching a revoked
          // one would resurrect the record the revoke just removed.
          if (decision.live) {
            await this.ctx.storage.put(
              key,
              renewRecord({
                record,
                nonce: input.nonce,
                name: decision.name,
                now,
                ttlSeconds: input.ttlSeconds,
              })
            );
          }

          return decision;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Paired-device touch failed — refusing the grant"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(
      grantTouchResult(outcome.value.live, outcome.value.name)
    );
  }

  /**
   * Un-pair one device. The record goes and a tombstone takes its place, because
   * the grant cookie on that phone is still a validly signed token — nothing but
   * the tombstone can refuse it, and it has to outlive the token to do so.
   */
  private async handleRevokeGrant(request: Request): Promise<Response> {
    const body = await Effect.runPromise(
      Effect.either(Effect.tryPromise(() => request.text()))
    );
    if (Either.isLeft(body)) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const input = parseRevokeGrantRequest(body.right);
    if (input === null) {
      return BoardRoom.json(errorEvent("invalid_command"), 400);
    }

    const now = Date.now();
    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(() =>
        this.ctx.blockConcurrencyWhile(async () => {
          const key = grantKey(input.nonce);
          const record = decodePairedDevice(await this.ctx.storage.get(key));
          // The tombstone outlives any grant that could still be presented. A
          // known record contributes its own expiry; an unknown nonce (a phone
          // paired before records existed) gets the ceiling, because there is
          // nothing else to go on and expiring a tombstone early would un-revoke
          // the device.
          const until =
            record === null
              ? now + MAX_GRANT_TOMBSTONE_MS
              : Math.max(record.expiresAt, now + 1000);
          await this.ctx.storage.put(revokedKey(input.nonce), until);
          await this.ctx.storage.delete(key);
          return record !== null;
        })
      )
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Paired-device revoke failed"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(grantRevokeResult(outcome.value));
  }

  /** Every device the owner can see and un-pair, newest-seen first. */
  private async handleListGrants(): Promise<Response> {
    const now = Date.now();
    const outcome = await Effect.runPromiseExit(
      Effect.tryPromise(async () => {
        await this.ctx.blockConcurrencyWhile(() => this.pruneGrants(now));
        const entries = await this.ctx.storage.list<unknown>({
          prefix: GRANT_KEY_PREFIX,
          limit: GRANT_PRUNE_LIMIT,
        });
        const devices: PairedDeviceRecord[] = [];
        for (const [, value] of entries) {
          const record = decodePairedDevice(value);
          if (record !== null) devices.push(record);
        }
        devices.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
        return devices;
      })
    );

    if (Exit.isFailure(outcome)) {
      log.error(
        { cause: Cause.pretty(outcome.cause) },
        "Paired-device list failed"
      );
      return BoardRoom.json(errorEvent("persist_failed"), 500);
    }

    return BoardRoom.json(pairedDeviceList(outcome.value));
  }

  /**
   * Drop expired records and expired tombstones. Runs inside the same
   * `blockConcurrencyWhile` as the write it precedes, exactly like `pruneNonces`.
   */
  private async pruneGrants(now: number): Promise<void> {
    const records = await this.ctx.storage.list<unknown>({
      prefix: GRANT_KEY_PREFIX,
      limit: GRANT_PRUNE_LIMIT,
    });
    const { dead } = pruneDevices([...records], now);

    const tombstones = await this.ctx.storage.list<unknown>({
      prefix: REVOKED_KEY_PREFIX,
      limit: GRANT_PRUNE_LIMIT,
    });
    const deadTombstones: string[] = [];
    for (const [key, value] of tombstones) {
      if (typeof value !== "number" || value <= now) deadTombstones.push(key);
    }

    const all = [...dead, ...deadTombstones];
    if (all.length > 0) await this.ctx.storage.delete(all);
  }

  /**
   * Keep the record set bounded. This is a storage bound, not a policy on how
   * many phones a family may own: the least-recently-seen device loses its
   * *record*, not its grant, so it keeps working and simply stops being
   * individually revocable until it next connects and re-records itself.
   */
  private async enforceDeviceLimit(): Promise<void> {
    const entries = await this.ctx.storage.list<unknown>({
      prefix: GRANT_KEY_PREFIX,
      limit: GRANT_PRUNE_LIMIT,
    });
    const records: PairedDeviceRecord[] = [];
    for (const [, value] of entries) {
      const record = decodePairedDevice(value);
      if (record !== null) records.push(record);
    }
    const victims = overflowVictims(records, MAX_PAIRED_DEVICES);
    if (victims.length > 0) {
      await this.ctx.storage.delete(victims.map(grantKey));
    }
  }

  // -------------------------------------------------------------------------
  // Hibernation handlers
  // -------------------------------------------------------------------------

  /** True for a TV parked on a device code rather than a screen showing a board. */
  private isDeviceCodeSocket(ws: WebSocket): boolean {
    return this.ctx.getTags(ws).includes(DEVICE_CODE_TAG);
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer
  ): Promise<void> {
    // A waiting TV is a listener, not a writer. It has presented no board and no
    // credential — it knows a code — so anything it sends is dropped rather than
    // parsed as a board command. Without this, holding a socket on a guessed
    // code would be a way to write to whatever board the room later serves.
    if (this.isDeviceCodeSocket(ws)) return;

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

    // The TV walking away is the liveness signal that expires an abandoned code.
    // Only when it was the last watcher, and only while the code is still
    // pending — a code that was already approved has left a tombstone, and
    // deleting that would turn a replay back into an `unknown`.
    if (this.isDeviceCodeSocket(ws)) {
      const remaining = this.ctx
        .getWebSockets(DEVICE_CODE_TAG)
        .filter((socket) => socket !== ws);
      if (remaining.length === 0) {
        const dropped = await Effect.runPromiseExit(
          Effect.tryPromise(() => this.ctx.storage.delete(DEVICE_CODE_KEY))
        );
        if (Exit.isFailure(dropped)) {
          log.warn(
            { cause: Cause.pretty(dropped.cause) },
            "Failed to expire an abandoned device code"
          );
        }
      }
    }

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
      // Board frames go to screens only. Filtering here rather than fanning out
      // to a `"board"` tag on purpose: sockets accepted by an earlier deploy
      // carry no tags at all and survive hibernation, so a tag-based fan-out
      // would silently stop updating every screen that was already connected
      // when this shipped.
      if (this.isDeviceCodeSocket(socket)) continue;
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
