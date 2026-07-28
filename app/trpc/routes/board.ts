import { Effect, Either, Schema } from "effect";
import { createTRPCRouter, protectedProcedure, publicProcedure } from "..";
import { runProcedure } from "@/lib/effect-trpc";
import { BoardRepository, parseSnapshotCells } from "@/repositories/board";
import { BoardRoom } from "@/services/board-room";
import { BoardAgent } from "@/services/board-agent";
import { AuthApi } from "@/services/auth";
import { ConfigurationError, NotFoundError } from "@/models/errors/repository";
import {
  PairingTokenInvalidError,
  RateLimitError,
  type PairingRefusal,
} from "@/models/errors/board";
import {
  DEFAULT_QUOTA,
  spenderId,
  type QuotaEndpoint,
} from "@/lib/board/quota";
import type { Board } from "@/db/schema";
import {
  BoardId,
  CreateBoardRouteInput,
  DeleteBoardInput,
  GenerateBoardMessageInput,
  GetBoardInput,
  GetHistoryInput,
  RenameBoardInput,
  RevokeControllersInput,
  SetBoardMessageInput,
  UpdateBoardSettingsInput,
} from "@/lib/schemas/board";
import {
  DEFAULT_GRANT_TTL_SECONDS,
  MAX_TOKEN_LENGTH,
  grantHistoryFloor,
  mintControllerGrant,
  readGrantCookies,
  verifyControllerGrants,
  verifyPairingToken,
} from "@/lib/board/pairing";

/**
 * Every board route is owner-scoped. A board that exists but belongs to someone
 * else fails as NotFoundError rather than FORBIDDEN — a wrong-owner request must
 * not confirm that the id is real, or the board list becomes enumerable.
 */
const requireOwnedBoard = (boardId: string, userId: string) =>
  Effect.gen(function* () {
    const repo = yield* BoardRepository;
    const board = yield* repo.getBoard({ boardId });
    if (board.ownerId !== userId) {
      return yield* Effect.fail(
        new NotFoundError({ entity: "board", identifier: boardId })
      );
    }
    return board;
  });

/* -------------------------------------------------------------------------- */
/* Pairing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The HMAC key for pairing tokens is `BETTER_AUTH_SECRET`, read off the already
 * constructed Better Auth instance rather than the env.
 *
 * Why not the `CloudflareEnv` tag: `runtime.ts` provides it with `Layer.provide`,
 * not `Layer.provideMerge`, so it is consumed while building `AppServices` and is
 * *not* a member of it — a procedure cannot yield it, and `ctx` (headers, runtime,
 * auth) carries no `cloudflare.env` either. `AuthApi` *is* in `AppServices`, and
 * it is built by `createAuth(env.DATABASE, env.BETTER_AUTH_SECRET, baseURL)`, so
 * `auth.options.secret` is that same secret verbatim — one secret, one read path,
 * no `process.env`.
 */
const pairingSecret = Effect.gen(function* () {
  const { auth } = yield* AuthApi;
  const secret = auth.options.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    return yield* Effect.fail(
      new ConfigurationError({ service: "Pairing", field: "BETTER_AUTH_SECRET" })
    );
  }
  return secret;
});

const logRefusal = (boardId: string, reason: PairingRefusal) =>
  Effect.logWarning("Pairing refused").pipe(
    // Precise server-side, generic client-side: `PairingTokenInvalidError` maps
    // to one UNAUTHORIZED message for every reason (see effect-trpc.ts).
    Effect.annotateLogs({ boardId, reason })
  );

/**
 * Spent-nonce ledger, backed by the board's **Durable Object storage**.
 *
 * A pairing token carries a random nonce and `verifyPairingToken` is stateless by
 * design, so single-use has to be enforced here. It is enforced in the room
 * because that is the one place where check-and-set is actually atomic: exactly
 * one Durable Object per board id, single-threaded, and the read → decide → write
 * runs inside `blockConcurrencyWhile`, so two devices redeeming the same token at
 * the same instant are serialised and exactly one is told it won.
 *
 * What this guarantees, precisely:
 *
 * - **Atomic per board.** Concurrent redemptions of one nonce cannot both succeed.
 * - **Storage-backed, so it survives eviction and hibernation** — a spend is a
 *   durable write, not a cache entry that may or may not still be there. It holds
 *   under `wrangler dev` local mode too, which the previous Cache API version did
 *   not: there, replay protection was simply absent.
 * - **Bounded.** Entries carry the token's own remaining life and the room prunes
 *   expired ones on each spend, so the ledger does not grow without bound.
 *
 * It is *not* a global mutex across boards, and it does not need to be: a nonce is
 * only ever presented with a token that is MAC-bound to one board id, so the
 * board's own room is the complete universe in which that nonce can be spent.
 *
 * Fails closed: `room.spendNonce` raises `ExternalServiceError` rather than
 * answering `false`, and that error is not caught here — an unreachable or broken
 * ledger refuses the pairing instead of waving it through.
 */

/** How the current caller is allowed to touch this board. */
type BoardAccessVia = "owner" | "grant";

interface BoardAccess {
  readonly via: BoardAccessVia;
  readonly board: Board;
  /** Epoch ms, or `null` for an owner session (whose lifetime is Better Auth's). */
  readonly grantExpiresAt: number | null;
  /** When the presented grant was minted; `null` for an owner session. */
  readonly grantIssuedAt: number | null;
  /**
   * The random nonce inside the grant that was accepted; `null` for an owner
   * session. This is the spend-cap bucket key: a caller cannot choose it, cannot
   * forge somebody else's, and cannot strip it without invalidating the token
   * that carries it — see `spenderId` in `@/lib/board/quota`.
   */
  readonly grantNonce: string | null;
}

/** The slice of a procedure context authorisation needs, session or not. */
interface BoardCallerContext {
  readonly headers: Headers;
  readonly auth: { readonly user: { readonly id: string } } | null;
}

/**
 * Read the board row, or `null` if there is no such board. A `QueryError` (the
 * database being unreachable) still propagates — only "does not exist" is folded
 * into the value channel, because that is the answer the authorisation branches
 * below need without being allowed to *report* it.
 */
const findBoard = (boardId: string) =>
  Effect.gen(function* () {
    const repo = yield* BoardRepository;
    return yield* repo
      .getBoard({ boardId })
      .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));
  });

/**
 * Owner session **or** a controller grant for this exact board.
 *
 * The grant is strictly narrower than a session: it is minted per board, bound to
 * that board id inside its MAC, and confers nothing beyond the write procedures
 * that call this helper. `list` and `create` (and `get`) never call it, so they
 * stay owner-only — a grant can neither enumerate the owner's boards nor make new
 * ones.
 *
 * ## Non-enumerability
 *
 * Which refusal a caller gets is decided **only by what the caller sent**, and the
 * order below is what makes that true rather than merely intended:
 *
 * - **No grant cookie for this id** (and no owning session) → `NotFoundError`.
 *   Identical for an id that does not exist and for a real board owned by someone
 *   else — including for a caller who *does* have a session, which is the case
 *   that used to leak: the board read happened first, so a signed-in caller could
 *   sort real ids (UNAUTHORIZED) from invented ones (NOT_FOUND) by sending one
 *   junk cookie.
 * - **A grant cookie for this id that does not verify** → `PairingTokenInvalidError`
 *   (UNAUTHORIZED), so the phone knows to rescan. Also returned when the board
 *   does not exist at all: presenting a cookie must never buy a different answer
 *   depending on whether the id is real. Anyone can fabricate that cookie for any
 *   id, so the branch reveals nothing.
 *
 * The board row is read before the grant is verified, because the grant's MAC
 * covers the board's `grantEpoch` and that is where the epoch lives. That read is
 * therefore unavoidable — but it is `findBoard`, whose absence verdict is
 * *unobservable*, so it cannot become the oracle it was.
 */
const requireBoardAccess = (ctx: BoardCallerContext, boardId: string) =>
  Effect.gen(function* () {
    // Read off the request, before any I/O: this decides which of the two
    // refusals is even reachable for this caller.
    const cookies = readGrantCookies(ctx.headers.get("cookie"), boardId);
    const board = yield* findBoard(boardId);

    if (
      board !== null &&
      ctx.auth !== null &&
      board.ownerId === ctx.auth.user.id
    ) {
      const access: BoardAccess = {
        via: "owner",
        board,
        grantExpiresAt: null,
        grantIssuedAt: null,
        grantNonce: null,
      };
      return access;
    }
    // An authenticated non-owner is not disqualified — they may still hold a
    // grant for this board (a signed-in phone that scanned someone's QR).

    if (cookies.length === 0) {
      return yield* Effect.fail(
        new NotFoundError({ entity: "board", identifier: boardId })
      );
    }

    if (board === null) {
      yield* logRefusal(boardId, "missing");
      return yield* Effect.fail(
        new PairingTokenInvalidError({ boardId, reason: "missing" })
      );
    }

    const secret = yield* pairingSecret;
    const verdict = yield* verifyControllerGrants({
      tokens: cookies,
      boardId,
      grantEpoch: board.grantEpoch,
      secret,
      now: Date.now(),
    });
    if (!verdict.ok) {
      yield* logRefusal(boardId, verdict.reason);
      return yield* Effect.fail(
        new PairingTokenInvalidError({ boardId, reason: verdict.reason })
      );
    }

    const access: BoardAccess = {
      via: "grant",
      board,
      grantExpiresAt: verdict.expiresAt,
      grantIssuedAt: verdict.issuedAt,
      grantNonce: verdict.nonce,
    };
    return access;
  });

/**
 * Charge one call against the board's spend caps, or refuse it.
 *
 * Called **after** authorisation and **before** the paid work, which is the only
 * ordering that makes sense: an unauthorised caller should not be able to move
 * anyone's counter, and a refused caller must not have cost anything by the time
 * they are told no.
 *
 * Fails closed. `room.spendQuota` raises `ExternalServiceError` rather than
 * answering `allowed: true` when the ledger is unreachable, and that error is
 * deliberately not caught here — a broken counter refuses the spend instead of
 * waving an unmetered call through to Anthropic.
 */
const chargeQuota = (
  access: BoardAccess,
  boardId: string,
  endpoint: QuotaEndpoint
) =>
  Effect.gen(function* () {
    const room = yield* BoardRoom;
    const verdict = yield* room.spendQuota({
      boardId,
      endpoint,
      spender: spenderId({
        via: access.via,
        ownerId: access.board.ownerId,
        grantNonce: access.grantNonce,
      }),
      policy: DEFAULT_QUOTA[endpoint],
    });

    if (!verdict.allowed) {
      yield* Effect.logWarning("Board spend cap reached").pipe(
        Effect.annotateLogs({
          boardId,
          endpoint,
          via: access.via,
          retryAfter: verdict.retryAfter,
        })
      );
      return yield* Effect.fail(
        new RateLimitError({ endpoint, retryAfter: verdict.retryAfter })
      );
    }
  });

/**
 * What a grant holder is allowed to know about a board. `ownerId` is withheld —
 * driving a board is not a reason to learn whose account it hangs off.
 */
const publicBoard = (board: Board) => ({
  id: board.id,
  name: board.name,
  soundPack: board.soundPack,
  muted: board.muted,
  revision: board.revision,
});

/**
 * Route-local inputs (the shared ones live in `app/lib/schemas/board.ts`). Effect
 * Schema, never Zod. The token is length-bounded before it reaches WebCrypto.
 */
const PairBoardInput = Schema.Struct({
  boardId: BoardId,
  token: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(MAX_TOKEN_LENGTH)
  ),
});

const ClaimBoardInput = Schema.Struct({ boardId: BoardId });

export const boardRouter = createTRPCRouter({
  create: protectedProcedure
    .input(Schema.standardSchemaV1(CreateBoardRouteInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const repo = yield* BoardRepository;
          return yield* repo.createBoard({
            ownerId: ctx.auth.user.id,
            name: input.name,
          });
        })
      )
    ),

  list: protectedProcedure.query(({ ctx }) =>
    runProcedure(
      ctx.runtime,
      Effect.gen(function* () {
        const repo = yield* BoardRepository;
        return yield* repo.getBoardsByOwner(ctx.auth.user.id);
      })
    )
  ),

  /**
   * The room is the authority on live state, so this reads through it rather
   * than off the latest D1 snapshot — the snapshot table is history, not truth.
   */
  get: protectedProcedure
    .input(Schema.standardSchemaV1(GetBoardInput))
    .query(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const board = yield* requireOwnedBoard(input.boardId, ctx.auth.user.id);
          const room = yield* BoardRoom;
          const state = yield* room.getState(input.boardId);
          return { board, state };
        })
      )
    ),

  /**
   * Redeem a pairing token for a controller grant. **The one board procedure
   * without a session requirement** — a phone that scanned the TV's QR has no
   * account, and requiring one would defeat the entire feature.
   *
   * The token itself is the credential: signed by us, bound to this board, valid
   * for ~120s, and single-use. UNAUTHORIZED here leaks nothing about board ids,
   * because reaching this procedure at all means presenting a token, and only a
   * token we signed for that exact board can pass.
   *
   * The grant is returned rather than written as a `Set-Cookie` here: tRPC's
   * context in this app exposes request headers only (`app/trpc/index.ts` builds
   * no `resHeaders`), so the caller — the `/b/:boardId/c` loader — sets the
   * `HttpOnly` cookie at the HTTP boundary where response headers exist.
   */
  pair: publicProcedure
    .input(Schema.standardSchemaV1(PairBoardInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const secret = yield* pairingSecret;
          const now = Date.now();

          // The board row comes first because the token's MAC covers this
          // board's `grantEpoch` — there is no verifying it without the row.
          // A missing board is refused as UNAUTHORIZED, never NOT_FOUND: this
          // procedure takes no session, so a NOT_FOUND here would let anyone
          // enumerate board ids with a junk token.
          const board = yield* findBoard(input.boardId);
          if (board === null) {
            yield* logRefusal(input.boardId, "missing");
            return yield* Effect.fail(
              new PairingTokenInvalidError({
                boardId: input.boardId,
                reason: "missing",
              })
            );
          }

          const verdict = yield* verifyPairingToken({
            token: input.token,
            boardId: input.boardId,
            grantEpoch: board.grantEpoch,
            secret,
            now,
          });
          if (!verdict.ok) {
            yield* logRefusal(input.boardId, verdict.reason);
            return yield* Effect.fail(
              new PairingTokenInvalidError({
                boardId: input.boardId,
                reason: verdict.reason,
              })
            );
          }

          /*
            Everything that can fail runs *before* the nonce is spent, and the
            spend is the last thing before the return.

            The previous order spent the nonce and then did three fallible things
            (`getBoard`, `room.getState`, `mintControllerGrant`), so a Durable
            Object hiccup burned a single-use token and issued nothing: the phone
            got the rescan prompt, the QR in its camera was already dead, and the
            only recovery was walking back to the TV.

            This is still replay-safe, because single-use was never about
            *ordering* — it is about `spendNonce` being an atomic check-and-set
            inside the room's `blockConcurrencyWhile`. Of two devices redeeming one
            nonce, exactly one is told it won; the loser is refused here. Minting a
            grant is a pure HMAC over values we already hold — no state, no I/O,
            nothing to roll back — so the loser's grant is simply discarded with
            the failed request. No response is emitted on any path that did not
            just win the spend, so "a grant was issued" still implies "this nonce
            was spent exactly once". What the reorder widens is only "a token may
            be *presented* more than once", which is what makes a transient
            failure retryable.
          */
          const room = yield* BoardRoom;
          const state = yield* room.getState(input.boardId);
          const grant = yield* mintControllerGrant({
            boardId: input.boardId,
            grantEpoch: board.grantEpoch,
            secret,
            now,
          });

          // The TTL is the token's own remaining life — the ledger never has to
          // remember a nonce for longer than the token that carries it could be
          // presented. Clamped to at least 1s so a token in its final
          // milliseconds still records a spend rather than rounding to zero.
          const remainingSeconds = Math.max(
            1,
            Math.ceil((verdict.expiresAt - now) / 1000)
          );
          const spent = yield* room.spendNonce(
            input.boardId,
            verdict.nonce,
            remainingSeconds
          );
          if (!spent) {
            yield* logRefusal(input.boardId, "spent");
            return yield* Effect.fail(
              new PairingTokenInvalidError({
                boardId: input.boardId,
                reason: "spent",
              })
            );
          }

          return {
            grant,
            grantMaxAgeSeconds: DEFAULT_GRANT_TTL_SECONDS,
            board: publicBoard(board),
            state,
          };
        })
      )
    ),

  /**
   * "Do I still hold a grant for this board?" Deliberately **never fails on an
   * authorisation verdict** — the phone calls this on load so it can render the
   * rescan prompt, and a thrown UNAUTHORIZED at that point would be an error
   * screen instead of an instruction. `ok: false` carries no reason (that stays
   * in the log) and no board data.
   */
  claim: publicProcedure
    .input(Schema.standardSchemaV1(ClaimBoardInput))
    .query(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const access = yield* Effect.either(
            requireBoardAccess(ctx, input.boardId)
          );
          if (Either.isLeft(access)) {
            yield* Effect.logInfo("Board claim declined").pipe(
              Effect.annotateLogs({
                boardId: input.boardId,
                failure: access.left._tag,
              })
            );
            return { ok: false as const };
          }

          const room = yield* BoardRoom;
          const state = yield* room.getState(input.boardId);
          return {
            ok: true as const,
            access: access.right.via,
            grantExpiresAt: access.right.grantExpiresAt,
            board: publicBoard(access.right.board),
            state,
          };
        })
      )
    ),

  /**
   * Writes go to the room only. The room compiles, assigns the revision,
   * broadcasts, and persists the snapshot — one write path, so a snapshot can
   * never disagree with what the TV is showing.
   *
   * Owner session **or** controller grant for this board — the whole point of
   * pairing is a phone that can write without an account.
   */
  setMessage: publicProcedure
    .input(Schema.standardSchemaV1(SetBoardMessageInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          yield* requireBoardAccess(ctx, input.boardId);
          const room = yield* BoardRoom;
          return yield* room.setMessage(input);
        })
      )
    ),

  /**
   * Let the LLM decide what the board says.
   *
   * Same authorisation as `setMessage` — owner session **or** controller grant —
   * because a paired phone driving the agent is the headline feature, not a
   * privileged operation. It writes exactly what `setMessage` writes, so a grant
   * gains no reach it did not already have.
   *
   * **One shot, no conversation history.** Continuity comes from the *board*
   * rather than a transcript: the current grid is read from the room and included
   * in the prompt, so "make it funnier" works against what the TV is actually
   * showing. That keeps the procedure stateless (nothing to store, nothing to
   * expire) and keeps every generation cheap.
   *
   * The write goes through `room.setMessage` like every other write — no snapshot
   * is persisted here. The room owns compilation, revision assignment,
   * broadcasting and the D1 snapshot, so an LLM board cannot end up disagreeing
   * with what the TV is displaying. `source: "llm"` and the prompt ride along, so
   * the history strip can show *why* the board says what it says.
   *
   * Never fails on a badly-shaped model response: the agent retries with the
   * decode error and then deterministically repairs, so the worst case is
   * `truncated: true` and clipped text.
   */
  generate: publicProcedure
    .input(Schema.standardSchemaV1(GenerateBoardMessageInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const access = yield* requireBoardAccess(ctx, input.boardId);
          // Before the model call, not after: a refusal must not have cost the
          // owner an Anthropic request.
          yield* chargeQuota(access, input.boardId, "generate");

          const room = yield* BoardRoom;
          const current = yield* room.getState(input.boardId);

          const agent = yield* BoardAgent;
          const generated = yield* agent.generate({
            prompt: input.prompt,
            current: current.grid,
          });

          yield* Effect.logInfo("Board generated").pipe(
            Effect.annotateLogs({
              boardId: input.boardId,
              attempts: generated.attempts,
              repaired: generated.repaired,
              truncated: generated.truncated,
            })
          );

          const state = yield* room.setMessage({
            boardId: input.boardId,
            baseRevision: input.baseRevision,
            message: generated.message,
            source: "llm",
            prompt: input.prompt,
          });

          return {
            state,
            // The room recompiles the same message, so these agree — surfaced at
            // the top level so the phone can hint "trimmed to fit" without
            // reaching into the room's state frame.
            truncated: state.truncated || generated.truncated,
            repaired: generated.repaired,
            attempts: generated.attempts,
          };
        })
      )
    ),

  /**
   * Grant-accessible as well: the phone's history strip is how a paired
   * controller re-flips something the board showed earlier.
   *
   * **A grant only sees back as far as itself.** `limit` goes to 100 and the rows
   * carry the `prompt` column, so without a floor a guest who scanned once could
   * pull the hundred most recent grids *and the text the owner dictated before
   * they arrived*. Driving the board tonight is not authorisation to read what it
   * said last week. The floor is the grant's own `issuedAt`, which
   * `verifyControllerGrant` already returns and no caller can influence — an
   * owner session keeps the full history.
   */
  history: publicProcedure
    .input(Schema.standardSchemaV1(GetHistoryInput))
    .query(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const access = yield* requireBoardAccess(ctx, input.boardId);
          const repo = yield* BoardRepository;
          const snapshots = yield* repo.getHistory({
            ...input,
            since: grantHistoryFloor(access),
          });
          // A snapshot written by another deploy could be unparseable; surface
          // it as grid: null instead of failing the whole history read.
          return snapshots.map((snapshot) => ({
            id: snapshot.id,
            revision: snapshot.revision,
            source: snapshot.source,
            prompt: snapshot.prompt,
            createdAt: snapshot.createdAt,
            grid: parseSnapshotCells(snapshot.cells),
          }));
        })
      )
    ),

  /**
   * Sound pack and mute. Two writes, in this order:
   *
   * 1. **D1** — the durable record of what this board's settings *are*.
   * 2. **The room** — what the TV actually reads, broadcast as a `state` frame so
   *    a mute silences the very next flip instead of the one after the next grid
   *    write.
   *
   * The room frame carries the **same revision**: settings are not a grid
   * generation, and the display's `shouldApplyState` applies equal revisions
   * precisely so this frame can land without inventing one.
   *
   * The room push is pushed *after* D1 and its failure is **not** swallowed. A
   * board whose row says muted while the TV is still clacking is the one outcome
   * worth reporting: the phone shows the write as failed, and a retry is safe
   * because both writes are idempotent.
   */
  updateSettings: publicProcedure
    .input(Schema.standardSchemaV1(UpdateBoardSettingsInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          yield* requireBoardAccess(ctx, input.boardId);
          const repo = yield* BoardRepository;
          const board = yield* repo.updateSettings(input);

          // Mirror the row we just read back, not `input` — D1 is the record, so
          // the room is told what the board *is*, which also repairs a room that
          // had drifted (fresh object, older deploy) rather than only applying
          // the delta.
          const room = yield* BoardRoom;
          yield* room.updateSettings({
            boardId: input.boardId,
            soundPack: board.soundPack,
            muted: board.muted,
          });

          return publicBoard(board);
        })
      )
    ),

  /**
   * Delete a board. Owner-only via `requireOwnedBoard` — deliberately **not**
   * `requireBoardAccess`. A controller grant authorises writing *to* a board
   * from a paired phone with no account; it must never be able to destroy the
   * board itself. Only the owning session can do that.
   *
   * `deleteBoard` verifies existence first, so a stale/foreign id fails as
   * `NotFoundError` rather than silently succeeding. `board_snapshot` cascades
   * on `board.id`, so the board's whole history goes with it in the same
   * delete. The Durable Object behind the board id is left as-is — see
   * `BoardRepository.deleteBoard` and the coordinator report for why that is
   * harmless.
   */
  delete: protectedProcedure
    .input(Schema.standardSchemaV1(DeleteBoardInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          yield* requireOwnedBoard(input.boardId, ctx.auth.user.id);
          const repo = yield* BoardRepository;
          return yield* repo.deleteBoard({ boardId: input.boardId });
        })
      )
    ),

  /**
   * Rename a board. Owner-only via `requireOwnedBoard` for the same reason as
   * `delete` — a grant is scoped to writing the board's *message*, not to
   * changing what the board is called.
   */
  rename: protectedProcedure
    .input(Schema.standardSchemaV1(RenameBoardInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          yield* requireOwnedBoard(input.boardId, ctx.auth.user.id);
          const repo = yield* BoardRepository;
          return yield* repo.renameBoard(input);
        })
      )
    ),

  /**
   * Kick every paired phone off this board.
   *
   * Increments the board's `grantEpoch`, which is inside the signed message of
   * every pairing token and controller grant it has ever issued — so all of them
   * fail as `bad-signature` from the next request onwards, for **this board
   * only**. Before this existed, the only ways to revoke a grant were deleting the
   * board or rotating `BETTER_AUTH_SECRET`, which signs out every user of the
   * deployment.
   *
   * `protectedProcedure` + `requireOwnedBoard`, never `requireBoardAccess`, and
   * that distinction is the whole point: a grant must not be able to revoke
   * grants. Same rule as `delete` and `rename`.
   *
   * The QR currently on the TV dies with everything else. The display re-mints on
   * its own timer (`QR_REFRESH_MS`, a third of the pairing TTL) so the screen
   * heals itself within seconds — and until it does, a code that was photographed
   * before the revoke is worthless, which is exactly what "revoke" should mean.
   */
  revokeControllers: protectedProcedure
    .input(Schema.standardSchemaV1(RevokeControllersInput))
    .mutation(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          yield* requireOwnedBoard(input.boardId, ctx.auth.user.id);
          const repo = yield* BoardRepository;
          const board = yield* repo.bumpGrantEpoch({ boardId: input.boardId });
          yield* Effect.logInfo("Board controllers revoked").pipe(
            Effect.annotateLogs({
              boardId: input.boardId,
              grantEpoch: board.grantEpoch,
            })
          );
          return { id: board.id, grantEpoch: board.grantEpoch };
        })
      )
    ),
});
