import { describe, it as itVitest, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer, Exit, Cause, Either } from "effect";
import { BoardRepository, parseSnapshotCells } from "../board";
import {
  chainable,
  chainableSpy,
  makeTestDatabase,
} from "@/services/database.test-layer";
import { board, boardSnapshot } from "@/db/schema";
import { NotFoundError } from "@/models/errors/repository";
import {
  BOARD_COLS,
  BOARD_ROWS,
  DEFAULT_BOARD_NAME,
  DEFAULT_HISTORY_LIMIT,
  decodeCreateBoardInput,
  decodeGetHistoryInput,
  decodeSaveSnapshotInput,
  type BoardGrid,
} from "@/lib/schemas/board";

const provideStub = (stub: unknown) =>
  BoardRepository.Default.pipe(Layer.provide(makeTestDatabase(stub)));

const cell = { char: "A", color: "white" } as const;
const gridRow = Array.from({ length: BOARD_COLS }, () => cell);
const grid: BoardGrid = {
  rows: Array.from({ length: BOARD_ROWS }, () => gridRow),
};

const expectFailureTag = (exit: Exit.Exit<unknown, unknown>, tag: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failure = Cause.failureOption(exit.cause);
    expect(failure._tag).toBe("Some");
    if (failure._tag === "Some") {
      expect((failure.value as { _tag: string })._tag).toBe(tag);
    }
  }
};

describe("parseSnapshotCells", () => {
  itVitest("round-trips a serialised grid", () => {
    const parsed = parseSnapshotCells(JSON.stringify(grid));
    expect(parsed).not.toBeNull();
    expect(parsed?.rows).toHaveLength(BOARD_ROWS);
    expect(parsed?.rows[0]).toHaveLength(BOARD_COLS);
    expect(parsed?.rows[0]?.[0]).toEqual(cell);
  });

  itVitest("returns null for malformed JSON", () => {
    expect(parseSnapshotCells("{not json")).toBeNull();
    expect(parseSnapshotCells("")).toBeNull();
  });

  itVitest("returns null for a structurally invalid grid", () => {
    expect(parseSnapshotCells(JSON.stringify({ rows: [] }))).toBeNull();
    expect(parseSnapshotCells(JSON.stringify({ rows: [gridRow] }))).toBeNull();
    expect(parseSnapshotCells(JSON.stringify(null))).toBeNull();
  });

  itVitest("returns null when a cell char is off the flap set", () => {
    const badRow = [{ char: "é", color: "white" }, ...gridRow.slice(1)];
    const bad = { rows: [badRow, ...grid.rows.slice(1)] };
    expect(parseSnapshotCells(JSON.stringify(bad))).toBeNull();
  });
});

describe("BoardRepository.getBoard", () => {
  it.effect("fails with NotFoundError when the board is missing", () => {
    const stub = { select: () => chainable([]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(repo.getBoard({ boardId: "missing" }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(NotFoundError);
        }
      }
      expectFailureTag(exit, "NotFoundError");
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("returns the board row when found", () => {
    const found = { id: "b1", ownerId: "u1", name: "kitchen", revision: 3 };
    const stub = { select: () => chainable([found]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.getBoard({ boardId: "b1" });
      expect(result).toEqual(found);
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.createBoard", () => {
  it.effect("inserts and returns the created row", () => {
    const created = { id: "generated", ownerId: "u1", name: DEFAULT_BOARD_NAME };
    const insertSpy = chainableSpy([created]);
    const stub = { insert: insertSpy };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.createBoard({
        ownerId: "u1",
        name: DEFAULT_BOARD_NAME,
      });
      expect(result).toEqual(created);
      expect(insertSpy).toHaveBeenCalledTimes(1);
      expect(insertSpy).toHaveBeenCalledWith(board);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("fails with CreationError when the insert throws", () => {
    const stub = {
      insert: () => {
        throw new Error("insert boom");
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(repo.createBoard({ ownerId: "u1", name: "x" }));
      expectFailureTag(exit, "CreationError");
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.getBoardsByOwner", () => {
  it.effect("returns the owner's boards", () => {
    const rows = [{ id: "b2" }, { id: "b1" }];
    const stub = { select: () => chainable(rows) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.getBoardsByOwner("u1");
      expect(result).toEqual(rows);
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.saveSnapshot", () => {
  it.effect("writes the snapshot and bumps the board revision", () => {
    const snapshot = { id: "s1", boardId: "b1", revision: 7, source: "manual" };
    const insertSpy = chainableSpy([snapshot]);
    const updateSpy = chainableSpy(undefined);
    const stub = { insert: insertSpy, update: updateSpy };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.saveSnapshot({
        boardId: "b1",
        revision: 7,
        grid,
        source: "manual",
      });
      expect(result).toEqual(snapshot);
      expect(insertSpy).toHaveBeenCalledTimes(1);
      expect(insertSpy).toHaveBeenCalledWith(boardSnapshot);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(updateSpy).toHaveBeenCalledWith(board);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("serialises the grid into the cells column", () => {
    const values: unknown[] = [];
    const stub = {
      insert: () => ({
        values: (v: unknown) => {
          values.push(v);
          return { returning: () => Promise.resolve([{ id: "s1" }]) };
        },
      }),
      update: chainableSpy(undefined),
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      yield* repo.saveSnapshot({
        boardId: "b1",
        revision: 1,
        grid,
        source: "llm",
        prompt: "say hello",
      });
      const inserted = values[0] as {
        cells: string;
        source: string;
        prompt: string | null;
      };
      expect(inserted.source).toBe("llm");
      expect(inserted.prompt).toBe("say hello");
      expect(parseSnapshotCells(inserted.cells)).toEqual(grid);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("stores a null prompt when none is given", () => {
    const values: unknown[] = [];
    const stub = {
      insert: () => ({
        values: (v: unknown) => {
          values.push(v);
          return { returning: () => Promise.resolve([{ id: "s1" }]) };
        },
      }),
      update: chainableSpy(undefined),
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      yield* repo.saveSnapshot({ boardId: "b1", revision: 1, grid, source: "manual" });
      expect((values[0] as { prompt: string | null }).prompt).toBeNull();
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("fails with CreationError when the snapshot insert throws", () => {
    const stub = {
      insert: () => {
        throw new Error("insert boom");
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.saveSnapshot({ boardId: "b1", revision: 1, grid, source: "manual" })
      );
      expectFailureTag(exit, "CreationError");
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.getLatestSnapshot", () => {
  it.effect("fails with NotFoundError when the board has no snapshots", () => {
    const stub = { select: () => chainable([]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.getLatestSnapshot({ boardId: "b1" })
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.failureOption(exit.cause);
        if (failure._tag === "Some") {
          expect(failure.value).toBeInstanceOf(NotFoundError);
        }
      }
      expectFailureTag(exit, "NotFoundError");
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("returns the highest-revision snapshot", () => {
    const latest = { id: "s9", boardId: "b1", revision: 9 };
    const stub = { select: () => chainable([latest]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.getLatestSnapshot({ boardId: "b1" });
      expect(result).toEqual(latest);
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.getHistory", () => {
  it.effect("passes the requested limit through to the query", () => {
    const rows = [{ id: "s3" }, { id: "s2" }];
    const limits: number[] = [];
    const stub = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => {
                limits.push(n);
                return Promise.resolve(rows);
              },
            }),
          }),
        }),
      }),
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.getHistory({ boardId: "b1", limit: 5 });
      expect(result).toEqual(rows);
      expect(limits).toEqual([5]);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("fails with QueryError when the select throws", () => {
    const stub = {
      select: () => {
        throw new Error("select boom");
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.getHistory({ boardId: "b1", limit: DEFAULT_HISTORY_LIMIT })
      );
      expectFailureTag(exit, "QueryError");
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.updateSettings", () => {
  it.effect("fails with NotFoundError when the board is missing", () => {
    const stub = { select: () => chainable([]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.updateSettings({ boardId: "missing", muted: true })
      );
      expectFailureTag(exit, "NotFoundError");
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("updates the given settings and returns the fresh row", () => {
    const updated = { id: "b1", soundPack: "retro", muted: true };
    const updateSpy = chainableSpy(undefined);
    const sets: unknown[] = [];
    const stub = {
      select: () => chainable([updated]),
      update: (...args: unknown[]) => {
        updateSpy(...(args as []));
        return {
          set: (patch: unknown) => {
            sets.push(patch);
            return { where: () => Promise.resolve(undefined) };
          },
        };
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.updateSettings({
        boardId: "b1",
        soundPack: "retro",
        muted: true,
      });
      expect(result).toEqual(updated);
      expect(updateSpy).toHaveBeenCalledWith(board);
      const patch = sets[0] as Record<string, unknown>;
      expect(patch.soundPack).toBe("retro");
      expect(patch.muted).toBe(true);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("omits fields that were not provided", () => {
    const sets: unknown[] = [];
    const stub = {
      select: () => chainable([{ id: "b1" }]),
      update: () => ({
        set: (patch: unknown) => {
          sets.push(patch);
          return { where: () => Promise.resolve(undefined) };
        },
      }),
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      yield* repo.updateSettings({ boardId: "b1", muted: false });
      const patch = sets[0] as Record<string, unknown>;
      expect("soundPack" in patch).toBe(false);
      expect(patch.muted).toBe(false);
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.deleteBoard", () => {
  it.effect("fails with NotFoundError when the board is missing", () => {
    const stub = { select: () => chainable([]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.deleteBoard({ boardId: "missing" })
      );
      expectFailureTag(exit, "NotFoundError");
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("deletes an existing board and returns success", () => {
    const found = { id: "b1", ownerId: "u1", name: "kitchen" };
    const deleteSpy = chainableSpy(undefined);
    const stub = { select: () => chainable([found]), delete: deleteSpy };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.deleteBoard({ boardId: "b1" });
      expect(result).toEqual({ success: true });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith(board);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("fails with DeletionError when the delete throws", () => {
    const found = { id: "b1", ownerId: "u1", name: "kitchen" };
    const stub = {
      select: () => chainable([found]),
      delete: () => {
        throw new Error("delete boom");
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(repo.deleteBoard({ boardId: "b1" }));
      expectFailureTag(exit, "DeletionError");
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

describe("BoardRepository.renameBoard", () => {
  it.effect("fails with NotFoundError when the board is missing", () => {
    const stub = { select: () => chainable([]) };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.renameBoard({ boardId: "missing", name: "kitchen" })
      );
      expectFailureTag(exit, "NotFoundError");
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("updates the name and returns the fresh row", () => {
    const renamed = { id: "b1", ownerId: "u1", name: "living room" };
    const updateSpy = chainableSpy(undefined);
    const sets: unknown[] = [];
    const stub = {
      select: () => chainable([renamed]),
      update: (...args: unknown[]) => {
        updateSpy(...(args as []));
        return {
          set: (patch: unknown) => {
            sets.push(patch);
            return { where: () => Promise.resolve(undefined) };
          },
        };
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const result = yield* repo.renameBoard({
        boardId: "b1",
        name: "living room",
      });
      expect(result).toEqual(renamed);
      expect(updateSpy).toHaveBeenCalledWith(board);
      const patch = sets[0] as Record<string, unknown>;
      expect(patch.name).toBe("living room");
      expect(patch.updatedAt).toBeInstanceOf(Date);
    }).pipe(Effect.provide(provideStub(stub)));
  });

  it.effect("fails with UpdateError when the update throws", () => {
    const found = { id: "b1", ownerId: "u1", name: "kitchen" };
    const stub = {
      select: () => chainable([found]),
      update: () => {
        throw new Error("update boom");
      },
    };
    return Effect.gen(function* () {
      const repo = yield* BoardRepository;
      const exit = yield* Effect.exit(
        repo.renameBoard({ boardId: "b1", name: "living room" })
      );
      expectFailureTag(exit, "UpdateError");
    }).pipe(Effect.provide(provideStub(stub)));
  });
});

/**
 * Input-schema decoding for the persistence inputs this repository consumes.
 * Lives here (not in `app/lib/schemas/__tests__/board.test.ts`) only because of
 * this track's file boundary — the coordinator may want to move it there.
 */
describe("board persistence input schemas", () => {
  itVitest("CreateBoardInput defaults the name", () => {
    const decoded = decodeCreateBoardInput({ ownerId: "u1" });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.name).toBe(DEFAULT_BOARD_NAME);
    }
  });

  itVitest("CreateBoardInput rejects an empty ownerId", () => {
    expect(Either.isLeft(decodeCreateBoardInput({ ownerId: "" }))).toBe(true);
  });

  itVitest("SaveSnapshotInput defaults source to manual", () => {
    const decoded = decodeSaveSnapshotInput({
      boardId: "b1",
      revision: 0,
      grid,
    });
    expect(Either.isRight(decoded)).toBe(true);
    if (Either.isRight(decoded)) {
      expect(decoded.right.source).toBe("manual");
      expect(decoded.right.prompt).toBeUndefined();
    }
  });

  itVitest("SaveSnapshotInput rejects a non-6x24 grid", () => {
    const decoded = decodeSaveSnapshotInput({
      boardId: "b1",
      revision: 0,
      grid: { rows: [gridRow] },
    });
    expect(Either.isLeft(decoded)).toBe(true);
  });

  itVitest("GetHistoryInput defaults and caps the limit", () => {
    const defaulted = decodeGetHistoryInput({ boardId: "b1" });
    expect(Either.isRight(defaulted)).toBe(true);
    if (Either.isRight(defaulted)) {
      expect(defaulted.right.limit).toBe(DEFAULT_HISTORY_LIMIT);
    }
    expect(
      Either.isLeft(decodeGetHistoryInput({ boardId: "b1", limit: 101 }))
    ).toBe(true);
    expect(
      Either.isLeft(decodeGetHistoryInput({ boardId: "b1", limit: 0 }))
    ).toBe(true);
  });
});
