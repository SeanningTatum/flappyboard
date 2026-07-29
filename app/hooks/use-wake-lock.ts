import { useEffect, useRef, useState } from "react";

/**
 * Keep the panel awake for as long as the board is on screen.
 *
 * **The runtime is a Samsung TV's built-in browser.** That is the whole design
 * brief. Tizen's browser most likely does not implement `navigator.wakeLock` at
 * all, so the silent looping muted `<video>` is the **primary** path here, not a
 * safety net bolted on for old browsers. The Wake Lock API is tried first only
 * because it is cheaper and cleaner where it happens to exist (a laptop running
 * the board during development, a Chromecast-class stick); on the device this
 * feature was written for, we expect to land on the video every single time.
 *
 * Three facts drive everything below:
 *
 * 1. **A wake lock is released the moment the page is hidden**, and the sentinel
 *    you were handed is dead for good. It has to be re-acquired on
 *    `visibilitychange`. This is the single most-missed part of the API — a hook
 *    that acquires once on mount looks correct in a demo and lets the TV sleep
 *    the first time someone switches input.
 * 2. **`request("screen")` rejects with `NotAllowedError` while the document is
 *    hidden.** That is ordinary, not a fault: a hidden page has nothing to keep
 *    awake. It must never surface as an error.
 * 3. **A hidden video does not hold anything awake.** The element has to be
 *    genuinely rendering — attached to the document, non-zero box, not
 *    `display: none`, not `visibility: hidden`. So it is parked off in a corner
 *    at 1×1 with `opacity: 0` instead.
 *
 * If both paths fail we return `{ held: false, via: "none" }` and **do nothing
 * else**: no thrown error, no toast, no retry loop, no console noise. A sleeping
 * TV is not an error state worth shouting about — the worst case is that someone
 * picks up the remote, and that is a far better outcome than a board that spams a
 * log or covers itself in a warning nobody is in the room to read.
 *
 * ## Why there is an "engine" under the hook
 *
 * Vitest runs in `environment: "node"` here (see `vitest.config.ts`) and the repo
 * carries no jsdom and no `@testing-library/react`, so a hook cannot be rendered
 * in a unit test at all. Same answer as `use-board-socket.ts`: push every
 * decision into something that can be driven without a DOM — there, exported pure
 * functions; here, `createWakeLockEngine(host)`, which takes the four things it
 * needs from the browser as an injected `WakeLockHost`. The hook itself is only
 * wiring, and `browserWakeLockHost()` is the one untested seam (four one-liners
 * over `navigator`/`document`).
 */

export type WakeLockVia = "screen-lock" | "video" | "none";

export interface WakeLockState {
  /** True while something is actively keeping the panel from sleeping. */
  readonly held: boolean;
  /** Which mechanism is holding it, for diagnostics on a TV nobody can attach a debugger to. */
  readonly via: WakeLockVia;
}

/** Nothing acquired: the pre-mount state, the server-rendered state, and the give-up state. */
export const IDLE_WAKE_LOCK: WakeLockState = { held: false, via: "none" };

/**
 * A 16×16, one-frame, ~810-byte H.264/MP4 clip, baseline profile, inlined as a
 * data URI.
 *
 * Inline rather than a file in `public/`, deliberately: the board must be able to
 * hold itself awake with zero extra network round-trips, including on the reload
 * that happens right after a router reboot when the TV is the first device back
 * on the wifi. Baseline H.264 in an MP4 container because that is the one codec
 * a Tizen browser is certain to decode — a WebM would be a coin flip.
 *
 * It has no audio track and is played muted regardless, so autoplay policy has no
 * grounds to refuse it, and it is black so a stray pixel cannot be seen against
 * the board's black field.
 */
export const KEEP_AWAKE_VIDEO_SRC =
  "data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAALrbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAjp0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGybWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABXW1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAR1zdGJsAAAAuXN0c2QAAAAAAAAAAQAAAKlhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAAL2F2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMACDxYuSABAAZoy4BlLIAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAAeAAAAAAAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAAADwAAAAEAAAAUc3RjbwAAAAAAAAABAAADGwAAAD11ZHRhAAAANW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAACGlsc3QAAAAIZnJlZQAAABdtZGF0AAAAC2WIhAV8mKAAISOA";

/** The sliver of `WakeLockSentinel` we touch. */
export interface ScreenWakeLockSentinel {
  readonly release: () => Promise<void> | void;
}

/** The sliver of `Navigator` we touch — `wakeLock` optional, because on the TV it is absent. */
export interface WakeLockCapableNavigator {
  readonly wakeLock?: {
    readonly request: (type: "screen") => Promise<ScreenWakeLockSentinel>;
  };
}

/** The sliver of `CSSStyleDeclaration` the off-screen video needs. */
export interface KeepAwakeVideoStyle {
  position: string;
  top: string;
  left: string;
  width: string;
  height: string;
  opacity: string;
  pointerEvents: string;
}

/** The sliver of `HTMLVideoElement` we touch. */
export interface KeepAwakeVideo {
  muted: boolean;
  loop: boolean;
  playsInline: boolean;
  autoplay: boolean;
  src: string;
  readonly style: KeepAwakeVideoStyle;
  readonly play: () => Promise<void> | void;
  readonly pause: () => void;
  readonly remove: () => void;
}

/**
 * Everything the engine needs from the outside world. Four members, all of them
 * boring, so a test can supply the lot in a dozen lines.
 */
export interface WakeLockHost {
  /** `navigator`. `undefined` only in an environment that has none. */
  readonly navigator: WakeLockCapableNavigator | undefined;
  /** A **detached** `<video>`. The engine configures it before it is attached, so nothing ever flashes on the board. */
  readonly createVideo: () => KeepAwakeVideo;
  /** Puts a configured video into the document. */
  readonly attachVideo: (video: KeepAwakeVideo) => void;
  /** `document.visibilityState === "visible"`. */
  readonly isVisible: () => boolean;
  /** Subscribes to `visibilitychange`; returns the unsubscribe. */
  readonly onVisibilityChange: (listener: () => void) => () => void;
}

export interface WakeLockEngine {
  /** Idempotent. `false` releases everything and unsubscribes; `true` acquires. */
  readonly setActive: (active: boolean) => void;
  readonly getState: () => WakeLockState;
  /** Returns the unsubscribe. Listeners fire only on an actual change. */
  readonly subscribe: (listener: (state: WakeLockState) => void) => () => void;
}

/**
 * The whole mechanism, minus the browser. See the module doc for why this exists
 * as a separate thing from the hook.
 */
export const createWakeLockEngine = (host: WakeLockHost): WakeLockEngine => {
  let active = false;
  let state: WakeLockState = IDLE_WAKE_LOCK;
  let sentinel: ScreenWakeLockSentinel | null = null;
  let video: KeepAwakeVideo | null = null;
  let detachVisibility: (() => void) | null = null;
  /** True between "started asking" and "got an answer" — stops a double-acquire. */
  let pending = false;
  /**
   * Bumped by every release. An acquire captures it and compares on the way
   * back, so a slow `request("screen")` that resolves *after* the board went
   * away is dropped instead of installing a lock nobody will ever release.
   */
  let generation = 0;

  const listeners = new Set<(state: WakeLockState) => void>();

  const publish = (next: WakeLockState): void => {
    if (next.held === state.held && next.via === state.via) return;
    state = next;
    listeners.forEach((listener) => listener(state));
  };

  /**
   * `release()` rejects when the lock is already gone — the page was hidden, the
   * OS took it back. There is nothing to do about that and nobody to tell, so it
   * is swallowed. Routed through `Promise.resolve().then(...)` so a *synchronous*
   * throw from an exotic implementation is caught by the same `.catch` (and so
   * this file needs no `try`/`catch`).
   */
  const releaseSentinel = (doomed: ScreenWakeLockSentinel): void => {
    void Promise.resolve()
      .then(() => doomed.release())
      .catch(() => {});
  };

  const detachVideo = (doomed: KeepAwakeVideo): void => {
    doomed.pause();
    doomed.remove();
  };

  /** Full teardown of whatever is currently held. Leaves `active` alone. */
  const releaseAll = (): void => {
    generation += 1;
    pending = false;

    const doomedSentinel = sentinel;
    sentinel = null;
    if (doomedSentinel !== null) releaseSentinel(doomedSentinel);

    const doomedVideo = video;
    video = null;
    if (doomedVideo !== null) detachVideo(doomedVideo);
  };

  /**
   * The fallback that is really the main path. Configure first, attach second:
   * an unconfigured `<video>` briefly occupies a 300×150 box in normal flow, and
   * on this route that is a grey rectangle across the board.
   */
  const acquireVideo = (mine: number): void => {
    const element = host.createVideo();
    element.muted = true;
    element.loop = true;
    element.playsInline = true;
    element.autoplay = true;
    element.src = KEEP_AWAKE_VIDEO_SRC;
    // Off-screen by *transparency and size*, never `display: none` — a video
    // that is not being rendered does not hold the panel awake, which is the
    // trap this whole fallback exists to avoid.
    element.style.position = "fixed";
    element.style.top = "0px";
    element.style.left = "0px";
    element.style.width = "1px";
    element.style.height = "1px";
    element.style.opacity = "0";
    element.style.pointerEvents = "none";
    host.attachVideo(element);
    video = element;

    void Promise.resolve()
      .then(() => element.play())
      .then(() => {
        if (mine !== generation) return;
        pending = false;
        publish({ held: true, via: "video" });
      })
      .catch(() => {
        // Autoplay refused, or the codec is not one this browser decodes. Take
        // the element back down and go quiet — see the module doc.
        if (video === element) {
          video = null;
          detachVideo(element);
        }
        if (mine !== generation) return;
        pending = false;
        publish(IDLE_WAKE_LOCK);
      });
  };

  const acquire = (): void => {
    if (!active || pending || sentinel !== null || video !== null) return;
    const mine = generation;
    pending = true;

    // Read through the object rather than destructuring `request` off it: the
    // spec method is called on `navigator.wakeLock` and loses `this` otherwise.
    const wakeLock = host.navigator?.wakeLock;
    if (wakeLock === undefined) {
      // The expected branch on the TV.
      acquireVideo(mine);
      return;
    }

    void Promise.resolve()
      .then(() => wakeLock.request("screen"))
      .then((granted) => {
        if (mine !== generation) {
          // The board went away while the request was in flight.
          releaseSentinel(granted);
          return;
        }
        pending = false;
        sentinel = granted;
        publish({ held: true, via: "screen-lock" });
      })
      .catch(() => {
        // `NotAllowedError` on a hidden document lands here and is not news.
        if (mine !== generation) return;
        acquireVideo(mine);
      });
  };

  /**
   * The re-acquire that everybody forgets. A screen lock is dropped by the
   * browser whenever the page hides and its sentinel cannot be revived, and a
   * backgrounded video is routinely paused by the OS — so on the way back to
   * visible we throw both away and start again rather than trusting a handle we
   * were given before the TV switched inputs.
   *
   * Going *hidden* is deliberately ignored: whatever we hold is already void, and
   * tearing it down would only race the browser doing the same thing.
   */
  const onVisibilityChange = (): void => {
    if (!active) return;
    if (!host.isVisible()) return;
    releaseAll();
    acquire();
  };

  const setActive = (next: boolean): void => {
    if (next === active) return;
    active = next;

    if (next) {
      detachVisibility = host.onVisibilityChange(onVisibilityChange);
      generation += 1;
      acquire();
      return;
    }

    detachVisibility?.();
    detachVisibility = null;
    releaseAll();
    publish(IDLE_WAKE_LOCK);
  };

  return {
    setActive,
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * The real host. The only place in this module that names `navigator`,
 * `document` or `window`, and it is called exclusively from inside an effect —
 * this app server-renders every route, so touching any of them during render
 * would break the board's first paint on the server.
 */
const browserWakeLockHost = (): WakeLockHost => ({
  navigator: navigator as WakeLockCapableNavigator,
  createVideo: () => document.createElement("video"),
  attachVideo: (element) => {
    // `createVideo` only ever hands back the element created directly above; the
    // cast is the price of keeping the engine free of any DOM type at all, and
    // therefore runnable under vitest's `node` environment.
    document.body.appendChild(element as unknown as HTMLVideoElement);
  },
  isVisible: () => document.visibilityState === "visible",
  onVisibilityChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => {
      document.removeEventListener("visibilitychange", listener);
    };
  },
});

/**
 * `active` is the board's own answer to "should this screen stay on?". Flip it
 * false and every handle is released synchronously; unmount does the same.
 */
export function useWakeLock(active: boolean): WakeLockState {
  const [state, setState] = useState<WakeLockState>(IDLE_WAKE_LOCK);
  const engineRef = useRef<WakeLockEngine | null>(null);

  // Mount-only: build the engine and start listening. Declared *before* the
  // `active` effect below so React runs it first on mount and its cleanup first
  // on unmount — the engine always exists by the time `active` is pushed in, and
  // is always torn down.
  useEffect(() => {
    const engine = createWakeLockEngine(browserWakeLockHost());
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setState);
    return () => {
      unsubscribe();
      // Releases the sentinel, pauses and removes the video, and drops the
      // `visibilitychange` listener. Nothing outlives the board.
      engine.setActive(false);
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.setActive(active);
  }, [active]);

  return state;
}
