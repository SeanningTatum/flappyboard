import { Effect, Either } from "effect";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { board, boardSnapshot } from "@/db/schema";
import { Database } from "@/services/database";
import {
  tryQuery,
  tryCreate,
  tryUpdate,
  tryDelete,
  requireFound,
} from "@/lib/effect-utils";
import { decodeBoardGrid, type BoardGrid } from "@/lib/schemas/board";
import type {
  CreateBoardInput,
  DeleteBoardInput,
  GetBoardInput,
  GetHistoryQuery,
  RenameBoardInput,
  SaveSnapshotInput,
  UpdateBoardSettingsInput,
} from "@/lib/schemas/board";

/**
 * Snapshot `cells` is a `JSON.stringify(BoardGrid)` blob written by an older or
 * newer deploy, so it is untrusted on read: parse AND validate the 6x24
 * invariant. Returns `null` on malformed JSON or a structurally invalid grid —
 * the caller decides whether that's a fallback-to-blank or a hard error.
 */
export const parseSnapshotCells = (cells: string): BoardGrid | null => {
  const parsed = Either.try({
    try: () => JSON.parse(cells) as unknown,
    catch: () => "invalid-json" as const,
  });
  if (Either.isLeft(parsed)) return null;
  const decoded = decodeBoardGrid(parsed.right);
  return Either.isLeft(decoded) ? null : decoded.right;
};

export class BoardRepository extends Effect.Service<BoardRepository>()(
  "app/BoardRepository",
  {
    effect: Effect.gen(function* () {
      const { db } = yield* Database;

      const createBoard = (input: CreateBoardInput) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID();
          const rows = yield* tryCreate("board", () =>
            db
              .insert(board)
              .values({ id, ownerId: input.ownerId, name: input.name })
              .returning()
          );
          return yield* requireFound("board", id, rows[0]);
        });

      const getBoard = (input: GetBoardInput) =>
        Effect.gen(function* () {
          const rows = yield* tryQuery("board", () =>
            db.select().from(board).where(eq(board.id, input.boardId)).limit(1)
          );
          return yield* requireFound("board", input.boardId, rows[0]);
        });

      const getBoardsByOwner = (ownerId: string) =>
        tryQuery("board", () =>
          db
            .select()
            .from(board)
            .where(eq(board.ownerId, ownerId))
            .orderBy(desc(board.createdAt))
        );

      const saveSnapshot = (input: SaveSnapshotInput) =>
        Effect.gen(function* () {
          const id = crypto.randomUUID();
          const rows = yield* tryCreate("board_snapshot", () =>
            db
              .insert(boardSnapshot)
              .values({
                id,
                boardId: input.boardId,
                revision: input.revision,
                cells: JSON.stringify(input.grid),
                source: input.source,
                prompt: input.prompt ?? null,
              })
              .returning()
          );
          const snapshot = yield* requireFound("board_snapshot", id, rows[0]);

          // The board's revision is the highest snapshot revision it has ever
          // had — never move it backwards when an older write lands late.
          yield* tryUpdate("board", () =>
            db
              .update(board)
              .set({ revision: input.revision, updatedAt: new Date() })
              .where(
                and(
                  eq(board.id, input.boardId),
                  sql`${board.revision} < ${input.revision}`
                )
              )
          );

          return snapshot;
        });

      const getLatestSnapshot = (input: GetBoardInput) =>
        Effect.gen(function* () {
          const rows = yield* tryQuery("board_snapshot", () =>
            db
              .select()
              .from(boardSnapshot)
              .where(eq(boardSnapshot.boardId, input.boardId))
              .orderBy(desc(boardSnapshot.revision))
              .limit(1)
          );
          return yield* requireFound("board_snapshot", input.boardId, rows[0]);
        });

      /**
       * `since` (epoch ms) is a **server-imposed** floor on `createdAt`, never a
       * client input — see `GetHistoryQuery` and `grantHistoryFloor`. It is what
       * keeps a controller grant from reading back the grids (and the prompts)
       * the owner wrote before that grant existed.
       */
      const getHistory = (input: GetHistoryQuery) =>
        tryQuery("board_snapshot", () =>
          db
            .select()
            .from(boardSnapshot)
            .where(
              input.since === undefined
                ? eq(boardSnapshot.boardId, input.boardId)
                : and(
                    eq(boardSnapshot.boardId, input.boardId),
                    gte(boardSnapshot.createdAt, new Date(input.since))
                  )
            )
            .orderBy(desc(boardSnapshot.revision))
            .limit(input.limit)
        );

      const updateSettings = (input: UpdateBoardSettingsInput) =>
        Effect.gen(function* () {
          yield* getBoard({ boardId: input.boardId });
          yield* tryUpdate("board", () =>
            db
              .update(board)
              .set({
                ...(input.soundPack === undefined
                  ? {}
                  : { soundPack: input.soundPack }),
                ...(input.muted === undefined ? {} : { muted: input.muted }),
                updatedAt: new Date(),
              })
              .where(eq(board.id, input.boardId))
          );
          return yield* getBoard({ boardId: input.boardId });
        });

      /**
       * Verifies the board exists (`NotFoundError` otherwise, not a silent
       * no-op) before deleting. `board_snapshot.boardId` is
       * `onDelete: "cascade"`, so every snapshot for this board goes with it —
       * no separate cleanup query needed here.
       */
      const deleteBoard = (input: DeleteBoardInput) =>
        Effect.gen(function* () {
          yield* getBoard({ boardId: input.boardId });
          yield* tryDelete("board", () =>
            db.delete(board).where(eq(board.id, input.boardId))
          );
          return { success: true } as const;
        });

      /**
       * Revoke every outstanding pairing token and controller grant for one
       * board by incrementing its `grantEpoch`.
       *
       * The increment is done in SQL (`grant_epoch = grant_epoch + 1`) rather
       * than read-modify-write, so two concurrent revokes both count instead of
       * one silently overwriting the other with the same value. Monotonic by
       * construction, so a bump can never accidentally *restore* a revoked
       * generation of tokens.
       *
       * Verifies existence first, so a stale or foreign id is a `NotFoundError`
       * rather than a silent no-op that reports success.
       */
      const bumpGrantEpoch = (input: GetBoardInput) =>
        Effect.gen(function* () {
          yield* getBoard({ boardId: input.boardId });
          yield* tryUpdate("board", () =>
            db
              .update(board)
              .set({
                grantEpoch: sql`${board.grantEpoch} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(board.id, input.boardId))
          );
          return yield* getBoard({ boardId: input.boardId });
        });

      /**
       * The display-side twin of `bumpGrantEpoch`: un-pair every TV showing this
       * board by incrementing `deviceEpoch`, leaving every paired phone alone.
       *
       * Same SQL-side increment for the same reason — two concurrent un-pairs
       * must both count, and the counter must only ever move forwards.
       */
      const bumpDeviceEpoch = (input: GetBoardInput) =>
        Effect.gen(function* () {
          yield* getBoard({ boardId: input.boardId });
          yield* tryUpdate("board", () =>
            db
              .update(board)
              .set({
                deviceEpoch: sql`${board.deviceEpoch} + 1`,
                updatedAt: new Date(),
              })
              .where(eq(board.id, input.boardId))
          );
          return yield* getBoard({ boardId: input.boardId });
        });

      const renameBoard = (input: RenameBoardInput) =>
        Effect.gen(function* () {
          yield* getBoard({ boardId: input.boardId });
          yield* tryUpdate("board", () =>
            db
              .update(board)
              .set({ name: input.name, updatedAt: new Date() })
              .where(eq(board.id, input.boardId))
          );
          return yield* getBoard({ boardId: input.boardId });
        });

      return {
        createBoard,
        getBoard,
        getBoardsByOwner,
        saveSnapshot,
        getLatestSnapshot,
        getHistory,
        updateSettings,
        deleteBoard,
        renameBoard,
        bumpGrantEpoch,
        bumpDeviceEpoch,
      } as const;
    }),
  }
) {}
