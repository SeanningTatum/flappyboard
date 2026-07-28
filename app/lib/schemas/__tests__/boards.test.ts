import { describe, expect, it } from "vitest";
import { Either, Schema } from "effect";

import { MAX_BOARD_NAME } from "../board";
import {
  CreateBoardFormSchema,
  RenameBoardFormSchema,
  boardControlPath,
  boardDisplayPath,
  boardTvUrl,
  isValidBoardName,
  normalizeBoardName,
} from "../boards";

const decodeForm = Schema.decodeUnknownEither(CreateBoardFormSchema);
const decodeRenameForm = Schema.decodeUnknownEither(RenameBoardFormSchema);

describe("CreateBoardFormSchema", () => {
  it("accepts a blank name — the procedure defaults it", () => {
    expect(Either.isRight(decodeForm({ name: "" }))).toBe(true);
  });

  it("accepts a name at the limit", () => {
    expect(Either.isRight(decodeForm({ name: "x".repeat(MAX_BOARD_NAME) }))).toBe(
      true
    );
  });

  it("rejects a name past the limit", () => {
    expect(
      Either.isLeft(decodeForm({ name: "x".repeat(MAX_BOARD_NAME + 1) }))
    ).toBe(true);
  });

  it("rejects a missing or non-string field", () => {
    expect(Either.isLeft(decodeForm({}))).toBe(true);
    expect(Either.isLeft(decodeForm({ name: 42 }))).toBe(true);
  });
});

describe("RenameBoardFormSchema", () => {
  it("accepts a normal name", () => {
    expect(Either.isRight(decodeRenameForm({ name: "kitchen" }))).toBe(true);
  });

  it("rejects a blank name — unlike create, rename has no server default", () => {
    expect(Either.isLeft(decodeRenameForm({ name: "" }))).toBe(true);
  });

  it("accepts a name at the limit and rejects one past it", () => {
    expect(
      Either.isRight(decodeRenameForm({ name: "x".repeat(MAX_BOARD_NAME) }))
    ).toBe(true);
    expect(
      Either.isLeft(decodeRenameForm({ name: "x".repeat(MAX_BOARD_NAME + 1) }))
    ).toBe(true);
  });
});

describe("normalizeBoardName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeBoardName("  kitchen  ")).toBe("kitchen");
  });

  it("collapses empty, whitespace-only, null and undefined to undefined", () => {
    expect(normalizeBoardName("")).toBeUndefined();
    expect(normalizeBoardName("   \t\n ")).toBeUndefined();
    expect(normalizeBoardName(null)).toBeUndefined();
    expect(normalizeBoardName(undefined)).toBeUndefined();
  });

  it("ignores non-string form values", () => {
    expect(normalizeBoardName(42 as unknown as string)).toBeUndefined();
  });

  it("keeps inner whitespace", () => {
    expect(normalizeBoardName(" front  desk ")).toBe("front  desk");
  });
});

describe("isValidBoardName", () => {
  it("accepts a normal name", () => {
    expect(isValidBoardName("kitchen")).toBe(true);
  });

  it("rejects empty and over-long names", () => {
    expect(isValidBoardName("")).toBe(false);
    expect(isValidBoardName("x".repeat(MAX_BOARD_NAME + 1))).toBe(false);
  });

  it("accepts a name of exactly the maximum length", () => {
    expect(isValidBoardName("x".repeat(MAX_BOARD_NAME))).toBe(true);
  });
});

describe("board link helpers", () => {
  it("builds the TV and controller paths", () => {
    expect(boardDisplayPath("seed-board")).toBe("/b/seed-board");
    expect(boardControlPath("seed-board")).toBe("/b/seed-board/c");
  });

  it("encodes ids that are not URL-safe", () => {
    expect(boardDisplayPath("a b/c")).toBe("/b/a%20b%2Fc");
    expect(boardControlPath("a b/c")).toBe("/b/a%20b%2Fc/c");
  });

  it("joins origin and path without doubling the slash", () => {
    expect(boardTvUrl("http://localhost:5173", "seed-board")).toBe(
      "http://localhost:5173/b/seed-board"
    );
    expect(boardTvUrl("http://localhost:5173/", "seed-board")).toBe(
      "http://localhost:5173/b/seed-board"
    );
    expect(boardTvUrl("https://flappyboard.example//", "seed-board")).toBe(
      "https://flappyboard.example/b/seed-board"
    );
  });
});
