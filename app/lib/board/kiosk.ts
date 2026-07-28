/**
 * The arithmetic behind leaving a board on a wall for months.
 *
 * Three unrelated-looking behaviours share this module because they share one
 * property: each is a *decision* that a component would otherwise make inline,
 * against a clock, inside an effect — which is to say untestable. Pulled out
 * here they are pure functions over a supplied `now`, exactly like
 * `pairing.ts`, and `display.tsx` keeps only the wiring.
 *
 * Nothing here touches the DOM, a timer, or `Date.now()`.
 */

/* -------------------------------------------------------------------------- */
/* Burn-in drift                                                              */
/* -------------------------------------------------------------------------- */

/**
 * How far the grid wanders, in pixels, at the extremes.
 *
 * Static high-contrast text held for hours is close to the worst case for an
 * OLED panel, and a split-flap board is nothing but static high-contrast text.
 * Three pixels is the standard mitigation: enough that no sub-pixel is lit
 * identically for more than one cycle, far too little for anyone in the room to
 * notice the board has moved.
 */
export const DRIFT_PX = 3;

/**
 * One step every four minutes — a full circuit takes sixteen. Slow enough to be
 * invisible in peripheral vision, frequent enough that the tiles are never
 * holding one exact position for a meaningful fraction of a day.
 */
export const DRIFT_INTERVAL_MS = 4 * 60 * 1000;

/** The cycle: right, down, left, up. Four positions, no diagonal jumps. */
const DRIFT_STEPS: ReadonlyArray<readonly [number, number]> = [
  [DRIFT_PX, 0],
  [0, DRIFT_PX],
  [-DRIFT_PX, 0],
  [0, -DRIFT_PX],
];

export interface DriftOffset {
  readonly x: number;
  readonly y: number;
}

/**
 * Where the grid sits on the `tick`-th step of the cycle.
 *
 * Driven by a counter rather than by the wall clock so it cannot jump on a
 * daylight-saving change, and taken modulo the cycle length so a display left up
 * for a year is doing exactly what one left up for an hour is doing.
 *
 * Negative and fractional ticks are folded rather than rejected: this is called
 * from a `setInterval` counter, and a caller that manages to hand it a bad
 * number should get a valid position, not a board that slides off screen.
 */
export const driftOffset = (tick: number): DriftOffset => {
  if (!Number.isFinite(tick)) return { x: 0, y: 0 };
  const steps = DRIFT_STEPS.length;
  const index = ((Math.floor(tick) % steps) + steps) % steps;
  const [x, y] = DRIFT_STEPS[index]!;
  return { x, y };
};

/* -------------------------------------------------------------------------- */
/* Idle dim                                                                   */
/* -------------------------------------------------------------------------- */

/** Lights out at 23:00, back up at 07:00 — a hallway board's own schedule. */
export const DIM_START_HOUR = 23;
export const DIM_END_HOUR = 7;

/**
 * How far down, not off. The board must still be readable by someone walking
 * past at 3am — the point is to stop it being the brightest thing in a dark
 * room, not to hide it.
 */
export const DIM_OPACITY = 0.35;

/**
 * Whether the board should be dimmed at this local hour.
 *
 * The window wraps midnight, which is the only interesting thing about it: a
 * naive `hour >= start && hour < end` is false for every hour of a window that
 * starts at 23 and ends at 7, and the bug is invisible in daylight.
 */
export const isDimHour = (hour: number): boolean => {
  if (!Number.isFinite(hour)) return false;
  const h = Math.floor(hour);
  if (h < 0 || h > 23) return false;
  return DIM_START_HOUR > DIM_END_HOUR
    ? h >= DIM_START_HOUR || h < DIM_END_HOUR
    : h >= DIM_START_HOUR && h < DIM_END_HOUR;
};

/** The opacity to render at, given the local hour. */
export const dimOpacity = (hour: number): number =>
  isDimHour(hour) ? DIM_OPACITY : 1;

/* -------------------------------------------------------------------------- */
/* Socket watchdog                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How long the socket may stay down before the page reloads itself.
 *
 * Two minutes, chosen against what the socket already does for itself: the
 * client reconnects with backoff, so anything shorter would fire during ordinary
 * recovery and turn a three-second blip into a reload. What this exists for is
 * the overnight case the reconnect loop cannot fix on its own — a worker
 * redeployed, a router rebooted, a socket wedged open but dead — where nobody is
 * awake to press anything.
 */
export const WATCHDOG_MS = 2 * 60 * 1000;

export interface WatchdogInput {
  /** The socket's own status, straight from `useBoardSocket`. */
  readonly status: string;
  /** When the status last became something other than `"live"`; `null` if live. */
  readonly downSince: number | null;
  readonly now: number;
  /** True once this page has already spent its one reload. */
  readonly reloaded: boolean;
}

/**
 * Whether to hard-reload the page.
 *
 * **Exactly once, ever.** A reload loop on a wall-mounted screen is strictly
 * worse than a stale board: the board at least still shows the last message,
 * whereas a page reloading every two minutes shows nothing, forever, and burns
 * a request every cycle for as long as the outage lasts. So the decision is
 * gated on `reloaded`, which the caller never resets — recovery after that is
 * the reconnect loop's job, or a human's.
 */
export const shouldReload = (input: WatchdogInput): boolean => {
  if (input.reloaded) return false;
  if (input.status === "live") return false;
  if (input.downSince === null) return false;
  return input.now - input.downSince >= WATCHDOG_MS;
};
