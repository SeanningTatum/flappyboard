import { describe, expect, it } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  backoffDelay,
  boardSocketUrl,
  changedCellCount,
  shouldApplyState,
} from "../use-board-socket";
import { blankGrid } from "@/lib/board/compile";
import { BOARD_COLS, BOARD_ROWS, type BoardGrid } from "@/lib/schemas/board";

/** Structural clone so a mutation in one grid can't leak into the other. */
const cloneGrid = (grid: BoardGrid): { rows: Array<Array<{ char: string; color: string }>> } => ({
  rows: grid.rows.map((row) => row.map((cell) => ({ ...cell }))),
});

const withCell = (
  grid: BoardGrid,
  row: number,
  col: number,
  cell: { char: string; color: string }
): BoardGrid => {
  const next = cloneGrid(grid);
  next.rows[row]![col] = cell;
  return next as unknown as BoardGrid;
};

describe("backoffDelay", () => {
  it("starts near the base delay on the first attempt", () => {
    expect(backoffDelay(0, 0)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffDelay(0, 1)).toBe(BACKOFF_BASE_MS);
  });

  it("doubles the window per attempt", () => {
    expect(backoffDelay(1, 1)).toBe(1_000);
    expect(backoffDelay(2, 1)).toBe(2_000);
    expect(backoffDelay(3, 1)).toBe(4_000);
    expect(backoffDelay(4, 1)).toBe(8_000);
  });

  it("never exceeds the cap, however many attempts have failed", () => {
    for (const attempt of [5, 6, 12, 40, 1_000, Number.MAX_SAFE_INTEGER]) {
      expect(backoffDelay(attempt, 1)).toBe(BACKOFF_CAP_MS);
      expect(backoffDelay(attempt, 0)).toBe(BACKOFF_CAP_MS / 2);
    }
  });

  it("keeps a floor of half the window so a flapping room isn't hammered", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
      for (const jitter of [0, 0.13, 0.5, 0.87, 1]) {
        const delay = backoffDelay(attempt, jitter);
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(delay).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it("spreads two callers apart for the same attempt", () => {
    expect(backoffDelay(4, 0)).not.toBe(backoffDelay(4, 1));
  });

  it("treats garbage attempts and jitter as attempt 0 / no jitter", () => {
    expect(backoffDelay(Number.NaN, 0)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffDelay(-7, 0)).toBe(BACKOFF_BASE_MS / 2);
    // A fractional attempt floors rather than producing a fractional window.
    expect(backoffDelay(1.9, 1)).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(0, Number.NaN)).toBe(BACKOFF_BASE_MS / 2);
    expect(backoffDelay(0, 4)).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(0, -4)).toBe(BACKOFF_BASE_MS / 2);
  });

  it("returns a real millisecond count for the default random jitter", () => {
    for (let i = 0; i < 50; i += 1) {
      const delay = backoffDelay(3);
      expect(Number.isInteger(delay)).toBe(true);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(4_000);
    }
  });
});

describe("shouldApplyState", () => {
  it("applies a newer revision", () => {
    expect(shouldApplyState(4, 5)).toBe(true);
  });

  it("drops an out-of-order frame from an older revision", () => {
    expect(shouldApplyState(9, 8)).toBe(false);
    expect(shouldApplyState(9, 0)).toBe(false);
  });

  it("applies an equal revision — settings-only frames don't bump the revision", () => {
    expect(shouldApplyState(9, 9)).toBe(true);
  });

  it("applies the very first frame onto a blank board", () => {
    expect(shouldApplyState(0, 0)).toBe(true);
    expect(shouldApplyState(0, 1)).toBe(true);
  });
});

describe("changedCellCount", () => {
  it("reports nothing for the first grid — a fresh mount must not clack", () => {
    expect(changedCellCount(null, blankGrid())).toBe(0);
  });

  it("reports zero for two structurally identical grids", () => {
    expect(changedCellCount(blankGrid(), blankGrid())).toBe(0);
  });

  it("counts a changed character", () => {
    const next = withCell(blankGrid(), 0, 0, { char: "A", color: "white" });
    expect(changedCellCount(blankGrid(), next)).toBe(1);
  });

  it("counts a recolour of the same character", () => {
    const before = withCell(blankGrid(), 2, 3, { char: "X", color: "white" });
    const after = withCell(blankGrid(), 2, 3, { char: "X", color: "red" });
    expect(changedCellCount(before, after)).toBe(1);
  });

  it("counts every differing cell", () => {
    let after = blankGrid();
    after = withCell(after, 0, 0, { char: "A", color: "white" });
    after = withCell(after, 1, 5, { char: "B", color: "green" });
    after = withCell(after, 5, 23, { char: "C", color: "violet" });
    expect(changedCellCount(blankGrid(), after)).toBe(3);
  });

  it("counts cells the previous grid never had rather than skipping them", () => {
    const truncated = { rows: [] } as unknown as BoardGrid;
    expect(changedCellCount(truncated, blankGrid())).toBe(BOARD_ROWS * BOARD_COLS);
  });
});

describe("boardSocketUrl", () => {
  it("upgrades https to wss", () => {
    expect(boardSocketUrl("https://board.example.com/b/abc", "abc")).toBe(
      "wss://board.example.com/api/board-ws?boardId=abc"
    );
  });

  it("upgrades http to ws for local dev", () => {
    expect(boardSocketUrl("http://localhost:5173/b/abc", "abc")).toBe(
      "ws://localhost:5173/api/board-ws?boardId=abc"
    );
  });

  it("keeps the port", () => {
    expect(boardSocketUrl("http://192.168.1.20:8788/b/x", "x")).toBe(
      "ws://192.168.1.20:8788/api/board-ws?boardId=x"
    );
  });

  it("drops the page's own query and hash instead of forwarding them", () => {
    expect(boardSocketUrl("https://tv.example/b/abc?debug=1#top", "abc")).toBe(
      "wss://tv.example/api/board-ws?boardId=abc"
    );
  });

  it("escapes a board id that would otherwise break the query", () => {
    expect(boardSocketUrl("https://tv.example/b/x", "a b&c=d")).toBe(
      "wss://tv.example/api/board-ws?boardId=a+b%26c%3Dd"
    );
  });

  it("always targets the page's own origin", () => {
    const url = new URL(boardSocketUrl("https://tv.example/anything/deep", "id"));
    expect(url.host).toBe("tv.example");
    expect(url.pathname).toBe("/api/board-ws");
  });
});
