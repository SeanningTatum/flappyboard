import { describe, expect, it } from "vitest";
import {
  dimOpacity,
  driftOffset,
  isDimHour,
  shouldReload,
  DIM_END_HOUR,
  DIM_OPACITY,
  DIM_START_HOUR,
  DRIFT_INTERVAL_MS,
  DRIFT_PX,
  WATCHDOG_MS,
} from "../kiosk";

describe("driftOffset", () => {
  it("walks a four-step cycle and returns to the start", () => {
    expect(driftOffset(0)).toEqual({ x: DRIFT_PX, y: 0 });
    expect(driftOffset(1)).toEqual({ x: 0, y: DRIFT_PX });
    expect(driftOffset(2)).toEqual({ x: -DRIFT_PX, y: 0 });
    expect(driftOffset(3)).toEqual({ x: 0, y: -DRIFT_PX });
    expect(driftOffset(4)).toEqual(driftOffset(0));
  });

  it("never exceeds the drift bound on any axis", () => {
    for (let tick = 0; tick < 40; tick += 1) {
      const { x, y } = driftOffset(tick);
      expect(Math.abs(x)).toBeLessThanOrEqual(DRIFT_PX);
      expect(Math.abs(y)).toBeLessThanOrEqual(DRIFT_PX);
    }
  });

  it("moves on exactly one axis at a time", () => {
    for (let tick = 0; tick < 12; tick += 1) {
      const { x, y } = driftOffset(tick);
      expect(x === 0 || y === 0).toBe(true);
    }
  });

  it("sums to zero over a full cycle, so the board does not wander", () => {
    const total = [0, 1, 2, 3].reduce(
      (acc, tick) => {
        const { x, y } = driftOffset(tick);
        return { x: acc.x + x, y: acc.y + y };
      },
      { x: 0, y: 0 }
    );
    expect(total).toEqual({ x: 0, y: 0 });
  });

  it("folds a negative tick instead of leaving the cycle", () => {
    expect(driftOffset(-1)).toEqual(driftOffset(3));
    expect(driftOffset(-4)).toEqual(driftOffset(0));
  });

  it("folds a fractional tick to its floor", () => {
    expect(driftOffset(1.9)).toEqual(driftOffset(1));
  });

  it("is the origin for a non-finite tick rather than NaN pixels", () => {
    expect(driftOffset(Number.NaN)).toEqual({ x: 0, y: 0 });
    expect(driftOffset(Number.POSITIVE_INFINITY)).toEqual({ x: 0, y: 0 });
  });

  it("cycles slowly enough to be invisible", () => {
    expect(DRIFT_INTERVAL_MS).toBeGreaterThanOrEqual(60_000);
  });
});

describe("isDimHour", () => {
  it("dims across the midnight wrap", () => {
    expect(isDimHour(23)).toBe(true);
    expect(isDimHour(0)).toBe(true);
    expect(isDimHour(3)).toBe(true);
    expect(isDimHour(6)).toBe(true);
  });

  it("is bright through the waking hours", () => {
    expect(isDimHour(7)).toBe(false);
    expect(isDimHour(12)).toBe(false);
    expect(isDimHour(22)).toBe(false);
  });

  it("treats the boundaries as start-inclusive and end-exclusive", () => {
    expect(isDimHour(DIM_START_HOUR)).toBe(true);
    expect(isDimHour(DIM_END_HOUR)).toBe(false);
    expect(isDimHour(DIM_START_HOUR - 1)).toBe(false);
    expect(isDimHour(DIM_END_HOUR - 1)).toBe(true);
  });

  it("covers every hour of the day exactly once, dim or bright", () => {
    const dim = [...Array(24).keys()].filter(isDimHour);
    expect(dim).toEqual([0, 1, 2, 3, 4, 5, 6, 23]);
  });

  it("rejects an hour outside the clock rather than guessing", () => {
    expect(isDimHour(-1)).toBe(false);
    expect(isDimHour(24)).toBe(false);
    expect(isDimHour(Number.NaN)).toBe(false);
  });
});

describe("dimOpacity", () => {
  it("dims at night and leaves the day alone", () => {
    expect(dimOpacity(2)).toBe(DIM_OPACITY);
    expect(dimOpacity(14)).toBe(1);
  });

  it("never dims to invisible — a passer-by must still be able to read it", () => {
    expect(DIM_OPACITY).toBeGreaterThan(0.15);
    expect(DIM_OPACITY).toBeLessThan(1);
  });
});

describe("shouldReload", () => {
  const NOW = 1_700_000_000_000;

  it("reloads once the socket has been down past the threshold", () => {
    expect(
      shouldReload({
        status: "offline",
        downSince: NOW - WATCHDOG_MS,
        now: NOW,
        reloaded: false,
      })
    ).toBe(true);
  });

  it("waits while the socket is still inside the threshold", () => {
    expect(
      shouldReload({
        status: "offline",
        downSince: NOW - WATCHDOG_MS + 1,
        now: NOW,
        reloaded: false,
      })
    ).toBe(false);
  });

  it("never reloads a live board", () => {
    expect(
      shouldReload({
        status: "live",
        downSince: NOW - WATCHDOG_MS * 10,
        now: NOW,
        reloaded: false,
      })
    ).toBe(false);
  });

  it("never reloads twice — a reload loop is worse than a stale board", () => {
    expect(
      shouldReload({
        status: "offline",
        downSince: NOW - WATCHDOG_MS * 10,
        now: NOW,
        reloaded: true,
      })
    ).toBe(false);
  });

  it("does nothing until a down-since has been recorded", () => {
    expect(
      shouldReload({
        status: "reconnecting",
        downSince: null,
        now: NOW,
        reloaded: false,
      })
    ).toBe(false);
  });

  it("applies to reconnecting as well as offline", () => {
    expect(
      shouldReload({
        status: "reconnecting",
        downSince: NOW - WATCHDOG_MS,
        now: NOW,
        reloaded: false,
      })
    ).toBe(true);
  });

  it("gives the socket's own backoff room to recover first", () => {
    expect(WATCHDOG_MS).toBeGreaterThanOrEqual(60_000);
  });
});
