import { Effect } from "effect";

/**
 * Sound layer for the split-flap board: which packs exist, and a small
 * abstraction over audio playback that behaves under the browser's autoplay
 * gate (no sound before a user gesture unlocks it).
 *
 * This module is imported during SSR (React Router renders on the server),
 * so nothing here may touch `window`/`Audio` at module scope. Every browser
 * object is created lazily, inside `createFlapPlayer`, and only once that
 * function is actually called.
 */

export interface SoundPack {
  readonly id: string;
  readonly label: string;
  readonly flapUrl: string;
}

export const SOUND_PACKS: ReadonlyArray<SoundPack> = [
  { id: "classic", label: "Classic", flapUrl: "/sfx/classic/flap.wav" },
  { id: "soft", label: "Soft", flapUrl: "/sfx/soft/flap.wav" },
];

export const DEFAULT_SOUND_PACK_ID = "classic";

const soundPackById = new Map(SOUND_PACKS.map((pack) => [pack.id, pack]));

/**
 * `board.soundPack` (see `app/lib/schemas/board.ts`) is just a length-bounded
 * string — the phone can send anything through it, so an unknown, empty, or
 * non-string id is a real path here, not a theoretical one. Total: never
 * throws, always returns something playable.
 */
export const resolveSoundPack = (id: string): SoundPack => {
  const fallback = soundPackById.get(DEFAULT_SOUND_PACK_ID)!;
  if (typeof id !== "string" || id.length === 0) return fallback;
  return soundPackById.get(id) ?? fallback;
};

/**
 * The slice of `HTMLAudioElement` the player actually touches. Narrowed to
 * an interface (rather than depending on the DOM lib type directly) so unit
 * tests can inject a plain object double — no jsdom, no real `<audio>`
 * element needed to exercise unlock/mute/pack-switching logic.
 */
export interface AudioLike {
  play: () => Promise<void> | void;
  pause: () => void;
  currentTime: number;
  volume: number;
  src: string;
  /**
   * Optional because it exists only to *vary* the clack, never to make one
   * possible: a pool element without it still plays, just at unity pitch. That
   * keeps the interface a strict superset of what it was, so an existing test
   * double is still a valid `AudioLike`.
   */
  playbackRate?: number;
}

export type AudioFactory = () => AudioLike;

/** Inert stand-in for environments with no `Audio` constructor (SSR, workers). */
const silentAudio = (): AudioLike => ({
  play: () => undefined,
  pause: () => {},
  currentTime: 0,
  volume: 1,
  src: "",
});

/**
 * `typeof Audio` never throws even when `Audio` isn't declared anywhere in
 * scope, unlike referencing the bare identifier — that's what makes this
 * safe to sit inside a function that could in principle run before a DOM
 * exists, without the module itself ever touching a browser global at
 * import time. In practice `createFlapPlayer` is only ever called from the
 * client, but this keeps the guarantee real rather than assumed.
 */
const defaultAudioFactory: AudioFactory = () =>
  typeof Audio === "undefined" ? silentAudio() : new Audio();

export interface FlapPlayer {
  unlock: () => Promise<boolean>;
  play: () => void;
  setPack: (id: string) => void;
  setMuted: (muted: boolean) => void;
  isUnlocked: () => boolean;
  /**
   * Drive from the animation loop, once per frame, with the number of tiles
   * still in motion. Emits at most one clack per call and only when one is
   * *due* — see `clatterIntervalMs`. Passing `0` (or being called with nothing
   * moving) ends the burst.
   *
   * `now` is injectable purely so the schedule is deterministic under test.
   */
  tick: (movingCells: number, now?: number) => void;
  /** End a burst early — the next `tick` clacks immediately. */
  stopClatter: () => void;
}

/* -------------------------------------------------------------------------- */
/* Clatter throttle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The floor on the gap between clacks, i.e. the **cap on the clack rate**:
 * 45ms ⇒ at most ~22 clacks/second however many tiles are flapping. Without a
 * cap the honest number would be one clack per tile per flap — 144 tiles × ~14
 * flaps/second ≈ 2,000 sounds/second, which is not a clatter, it is white noise
 * and a stalled main thread.
 */
export const CLATTER_MIN_INTERVAL_MS = 45;

/**
 * The ceiling: a single tile still turning gets a lazy ~4 clicks/second rather
 * than falling silent. This is what makes the tail of a board change read as
 * "one last tile finding its letter".
 */
export const CLATTER_MAX_INTERVAL_MS = 260;

/**
 * Sets the curve between those two bounds. `interval = BASE / sqrt(moving)`, so
 * the rate rises with the square root of the number of moving tiles rather than
 * linearly: 144 tiles and 100 tiles both sound "full" (both clamp to the cap),
 * while the interesting part of the range — the last 30 or so tiles landing one
 * by one — is spread out where the ear can actually hear it thin. A linear law
 * spent the whole dynamic range on the first fifty tiles and then dropped to
 * silence.
 */
export const CLATTER_BASE_MS = 320;

/**
 * How long to wait before the next clack, given how many tiles are still
 * moving. `Infinity` for "nothing is moving", which is the natural encoding of
 * "never" for a `now - last >= interval` test.
 */
export const clatterIntervalMs = (movingCells: number): number => {
  if (typeof movingCells !== "number" || !Number.isFinite(movingCells)) {
    return Number.POSITIVE_INFINITY;
  }
  if (movingCells <= 0) return Number.POSITIVE_INFINITY;
  const raw = CLATTER_BASE_MS / Math.sqrt(movingCells);
  return Math.min(CLATTER_MAX_INTERVAL_MS, Math.max(CLATTER_MIN_INTERVAL_MS, raw));
};

/**
 * mulberry32, the same construction `scripts/generate-sfx.ts` uses. Seeded, so
 * the pitch/level jitter below is deterministic — the point is only that
 * successive clacks are not *identical*, not that they are unpredictable.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** ±8% pitch and −18%…0 level. Enough to break the metronome, cheap as one multiply. */
const RATE_SPREAD = 0.16;
const LEVEL_SPREAD = 0.18;

/** Reads a monotonic clock where there is one, and a wall clock where there isn't. */
const defaultClock = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

/**
 * A single board update can flip many tiles in one tick, each wanting its
 * own flap sound. This pool of pre-built elements, cycled round-robin, is
 * the middle ground between two worse options: a single shared element
 * would cut off the previous flap's decay every time a new one fires,
 * killing the overlapping "clatter" that sells a multi-tile update; a fresh
 * `cloneNode` (or `new Audio()`) per play() call creates unbounded throwaway
 * objects exactly when the board is busiest. A fixed-size pool bounds
 * memory regardless of how many tiles change, at the cost of at most
 * `POOL_SIZE` simultaneous overlapping flaps — plenty for a mechanical
 * clack effect.
 *
 * Raised from 4 to 6 for the sustained clatter. At the rate cap
 * (`CLATTER_MIN_INTERVAL_MS = 45ms`) a new clack starts every 45ms, and the
 * "soft" pack's sample is 130ms long — so ~3 clacks genuinely overlap and a
 * 4-element pool would come back round to an element that is still decaying and
 * cut its tail. Cut tails are exactly what makes a rattle sound like a
 * metronome. 6 is 2× the measured overlap: bounded, allocated once at
 * construction, and still nothing per `play()`.
 */
const POOL_SIZE = 6;

export const createFlapPlayer = (opts: {
  packId: string;
  muted: boolean;
  /** Test seam: inject a fake in place of real `Audio` elements. */
  audioFactory?: AudioFactory;
  /** Test seam: inject a deterministic clock for the clatter schedule. */
  now?: () => number;
}): FlapPlayer => {
  const audioFactory = opts.audioFactory ?? defaultAudioFactory;
  const clock = opts.now ?? defaultClock;
  const pool: ReadonlyArray<AudioLike> = Array.from(
    { length: POOL_SIZE },
    () => audioFactory()
  );

  let muted = opts.muted;
  let unlocked = false;
  let nextIndex = 0;
  /** `-Infinity` means "a clack is due right now", which is true at burst start. */
  let lastClackAt = Number.NEGATIVE_INFINITY;
  const jitter = mulberry32(0x666c6170); // "flap"

  const applyPack = (id: string): void => {
    const pack = resolveSoundPack(id);
    for (const element of pool) {
      element.src = pack.flapUrl;
    }
  };
  applyPack(opts.packId);

  /**
   * Autoplay gates require a play() call that traces back to a user
   * gesture. Every pooled element gets its own silent unlock attempt —
   * some browsers unlock playback per-element rather than per-page, so
   * unlocking only one would leave the rest of the pool still blocked the
   * first time it's their turn in the round-robin. Volume is zeroed and
   * restored around the probe so unlocking doesn't itself produce an
   * audible blip. A rejection is the browser declining, not a bug — caught
   * per element and folded into the boolean result, never left as an
   * unhandled rejection.
   *
   * The probe runs through `Effect.tryPromise` rather than `try` / `catch`: this
   * is `app/lib/`, where the Effect-by-default rule has no component or
   * event-handler exemption. `Effect.ensuring` restores the volume on every path,
   * which is what the `finally` did, and the returned `Promise<boolean>` is
   * unchanged — `display.tsx` and the `FlapPlayer` contract see the same
   * function.
   */
  const probe = (element: AudioLike): Effect.Effect<boolean> => {
    const previousVolume = element.volume;
    return Effect.sync(() => {
      element.volume = 0;
      element.currentTime = 0;
    }).pipe(
      Effect.andThen(
        Effect.tryPromise({
          // One `await` for the play, then the wind-down: an element that throws
          // on `pause()` is as unusable as one that refuses to play, so both land
          // on `false` exactly as the original `try` block did.
          try: async () => {
            await Promise.resolve(element.play());
            element.pause();
            element.currentTime = 0;
          },
          catch: () => "refused" as const,
        })
      ),
      Effect.as(true),
      Effect.catchAll(() => Effect.succeed(false)),
      Effect.ensuring(
        Effect.sync(() => {
          element.volume = previousVolume;
        })
      )
    );
  };

  const unlock = async (): Promise<boolean> => {
    if (unlocked) return true;

    const results = await Effect.runPromise(
      // Every pooled element is probed, and one refusal does not stop the rest —
      // `Effect.all` with `mode: "either"` is unnecessary because `probe` never
      // fails, it answers.
      Effect.all(pool.map(probe), { concurrency: "unbounded" })
    );
    unlocked = results.every((ok) => ok);
    return unlocked;
  };

  const play = (): void => {
    if (muted || !unlocked) return;
    const element = pool[nextIndex]!;
    nextIndex = (nextIndex + 1) % pool.length;
    element.currentTime = 0;
    // Two identical clacks in a row are the tell that a sound is synthetic, and
    // a sustained clatter is nothing but clacks in a row. One WAV, varied per
    // play: a little pitch (which on a percussive sample also shortens or
    // lengthens the tail) and a little level. Two multiplies, no allocation.
    if (typeof element.playbackRate === "number") {
      element.playbackRate = 1 - RATE_SPREAD / 2 + jitter() * RATE_SPREAD;
    }
    element.volume = 1 - LEVEL_SPREAD + jitter() * LEVEL_SPREAD;
    // A refusal here (autoplay revoked mid-session, or the element is still
    // tearing down from its previous play) is normal, not exceptional —
    // swallow it rather than let it surface as an unhandled rejection.
    void Promise.resolve(element.play()).catch(() => {});
  };

  const stopClatter = (): void => {
    lastClackAt = Number.NEGATIVE_INFINITY;
  };

  /**
   * The whole sustained-clatter mechanism, and it is deliberately this small:
   * one bounded rate, driven from the animator's own loop, with the rate falling
   * out of how many tiles are still moving. No per-tile bookkeeping, no queue,
   * no timers of its own — so it cannot drift out of step with the animation and
   * cannot outlive it.
   *
   * `play()` still owns the mute and autoplay gates, so a muted or not-yet-
   * unlocked board runs the full animation in silence with this called every
   * frame throughout.
   */
  const tick = (movingCells: number, now: number = clock()): void => {
    const interval = clatterIntervalMs(movingCells);
    if (!Number.isFinite(interval)) {
      stopClatter();
      return;
    }
    if (!Number.isFinite(now)) return;
    if (now - lastClackAt < interval) return;
    lastClackAt = now;
    play();
  };

  const setPack = (id: string): void => {
    applyPack(id);
  };

  const setMuted = (nextMuted: boolean): void => {
    muted = nextMuted;
  };

  const isUnlocked = (): boolean => unlocked;

  return { unlock, play, setPack, setMuted, isUnlocked, tick, stopClatter };
};
