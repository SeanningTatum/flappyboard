import { describe, expect, it, vi } from "vitest";

import {
  createWakeLockEngine,
  IDLE_WAKE_LOCK,
  KEEP_AWAKE_VIDEO_SRC,
  type KeepAwakeVideo,
  type ScreenWakeLockSentinel,
  type WakeLockHost,
  type WakeLockState,
} from "../use-wake-lock";

/**
 * These drive `createWakeLockEngine` rather than `useWakeLock`, because there is
 * no DOM to render a hook into: vitest runs `environment: "node"` here and the
 * repo carries neither jsdom nor `@testing-library/react`, so `renderHook` and a
 * probe component are equally unavailable. The engine is the whole mechanism —
 * the hook is four lines of `useEffect` around `setActive` — so every behaviour
 * the TV depends on is reachable from here, and the injected `WakeLockHost`
 * stands in for the browser.
 *
 * "Unmount" below therefore means `setActive(false)`, which is literally what the
 * hook's cleanup calls.
 */

/** Nothing in the engine waits on a timer, but every path resolves through microtasks. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

type FakeVideo = KeepAwakeVideo & { attached: boolean };

const makeVideo = (canPlay: boolean): FakeVideo => ({
  muted: false,
  loop: false,
  playsInline: false,
  autoplay: false,
  src: "",
  style: {
    position: "",
    top: "",
    left: "",
    width: "",
    height: "",
    opacity: "",
    pointerEvents: "",
  },
  play: vi.fn(() =>
    canPlay
      ? Promise.resolve()
      : Promise.reject(new Error("NotAllowedError: autoplay refused"))
  ),
  pause: vi.fn(),
  remove: vi.fn(),
  attached: false,
});

interface TestHostOptions {
  /** `"absent"` is the Samsung TV: no `navigator.wakeLock` at all. */
  readonly wakeLock?: "grants" | "rejects" | "absent";
  readonly videoPlays?: boolean;
  readonly visible?: boolean;
}

interface TestHost {
  readonly host: WakeLockHost;
  readonly request: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly videos: ReadonlyArray<FakeVideo>;
  readonly listeners: ReadonlyArray<() => void>;
  /** How many `visibilitychange` subscriptions are currently live. */
  readonly liveListenerCount: () => number;
  readonly setVisible: (visible: boolean) => void;
  readonly fireVisibilityChange: () => void;
}

const makeTestHost = ({
  wakeLock = "grants",
  videoPlays = true,
  visible = true,
}: TestHostOptions = {}): TestHost => {
  const videos: Array<FakeVideo> = [];
  const listeners: Array<() => void> = [];
  const live = new Set<() => void>();
  let isVisible = visible;

  const release = vi.fn(() => Promise.resolve());
  const request = vi.fn(
    (): Promise<ScreenWakeLockSentinel> =>
      wakeLock === "grants"
        ? Promise.resolve({ release })
        : Promise.reject(new Error("NotAllowedError: document is hidden"))
  );

  const host: WakeLockHost = {
    navigator: wakeLock === "absent" ? {} : { wakeLock: { request } },
    createVideo: () => {
      const video = makeVideo(videoPlays);
      videos.push(video);
      return video;
    },
    attachVideo: (element) => {
      (element as FakeVideo).attached = true;
    },
    isVisible: () => isVisible,
    onVisibilityChange: (listener) => {
      listeners.push(listener);
      live.add(listener);
      return () => {
        live.delete(listener);
      };
    },
  };

  return {
    host,
    request,
    release,
    videos,
    listeners,
    liveListenerCount: () => live.size,
    setVisible: (next) => {
      isVisible = next;
    },
    fireVisibilityChange: () => {
      listeners.forEach((listener) => listener());
    },
  };
};

/** Collects everything the hook's `setState` would have been handed. */
const track = (engine: ReturnType<typeof createWakeLockEngine>) => {
  const seen: Array<WakeLockState> = [];
  engine.subscribe((state) => seen.push(state));
  return seen;
};

describe("createWakeLockEngine — the screen-lock path", () => {
  it("asks the Wake Lock API first where the browser has one", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.request).toHaveBeenCalledWith("screen");
    expect(engine.getState()).toEqual({ held: true, via: "screen-lock" });
    // No fallback was built — a video that nobody needs is still a video
    // decoding on a TV's very modest SoC.
    expect(test.videos).toHaveLength(0);
  });

  it("publishes the change exactly once", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);
    const seen = track(engine);

    engine.setActive(true);
    await settle();

    expect(seen).toEqual([{ held: true, via: "screen-lock" }]);
  });

  it("does not ask twice when the board asks twice", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    engine.setActive(true);
    await settle();
    engine.setActive(true);
    await settle();

    expect(test.request).toHaveBeenCalledTimes(1);
  });
});

describe("createWakeLockEngine — the video path (the Samsung TV)", () => {
  it("goes straight to the video when the browser has no wakeLock at all", async () => {
    const test = makeTestHost({ wakeLock: "absent" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    expect(test.videos).toHaveLength(1);
    expect(test.videos[0]?.play).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toEqual({ held: true, via: "video" });
  });

  it("falls back to the video when the API rejects", async () => {
    // `request("screen")` rejects with NotAllowedError on a hidden document.
    // Ordinary, not a fault — and the board still needs to stay awake.
    const test = makeTestHost({ wakeLock: "rejects" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.videos).toHaveLength(1);
    expect(engine.getState()).toEqual({ held: true, via: "video" });
  });

  it("configures the video so it can actually hold the panel awake", async () => {
    const test = makeTestHost({ wakeLock: "absent" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    const video = test.videos[0];
    expect(video).toBeDefined();
    expect(video?.muted).toBe(true);
    expect(video?.loop).toBe(true);
    expect(video?.playsInline).toBe(true);
    expect(video?.src).toBe(KEEP_AWAKE_VIDEO_SRC);
    // In the document, or it holds nothing.
    expect(video?.attached).toBe(true);
    // Off-screen by transparency and size, never by being un-rendered: a
    // `display: none` video does not keep a panel awake.
    expect(video?.style.opacity).toBe("0");
    expect(video?.style.width).not.toBe("0px");
    expect(video?.style.height).not.toBe("0px");
    expect(video?.style).not.toHaveProperty("display");
    expect(video?.style).not.toHaveProperty("visibility");
    // It must not be clickable either — it sits over the board's top-left corner.
    expect(video?.style.pointerEvents).toBe("none");
  });

  it("carries a decodable inline clip rather than a network URL", () => {
    // A board reloading right after a router reboot may be the first device back
    // on the wifi; the keep-awake path must not need the network.
    expect(KEEP_AWAKE_VIDEO_SRC.startsWith("data:video/mp4;base64,")).toBe(true);
    const payload = KEEP_AWAKE_VIDEO_SRC.slice("data:video/mp4;base64,".length);
    expect(payload.length).toBeGreaterThan(100);
    const decoded = Buffer.from(payload, "base64");
    // `....ftypisom` — a real MP4 box header, not a truncated paste.
    expect(decoded.subarray(4, 12).toString("latin1")).toBe("ftypisom");
  });
});

describe("createWakeLockEngine — when nothing works", () => {
  it("reports via:none and does not throw when both paths fail", async () => {
    const test = makeTestHost({ wakeLock: "rejects", videoPlays: false });
    const engine = createWakeLockEngine(test.host);

    expect(() => engine.setActive(true)).not.toThrow();
    await settle();

    expect(engine.getState()).toEqual(IDLE_WAKE_LOCK);
    expect(engine.getState()).toEqual({ held: false, via: "none" });
  });

  it("takes the dead video back down instead of leaving it in the page", async () => {
    const test = makeTestHost({ wakeLock: "absent", videoPlays: false });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    expect(test.videos[0]?.pause).toHaveBeenCalledTimes(1);
    expect(test.videos[0]?.remove).toHaveBeenCalledTimes(1);
  });

  it("stays quiet — no state ever goes out, because nothing ever changed", async () => {
    // A sleeping TV is not an error state worth shouting about: the failure is
    // indistinguishable, from the outside, from never having been asked.
    const test = makeTestHost({ wakeLock: "rejects", videoPlays: false });
    const engine = createWakeLockEngine(test.host);
    const seen = track(engine);

    engine.setActive(true);
    await settle();

    expect(seen).toEqual([]);
  });

  it("does not retry in a loop after giving up", async () => {
    const test = makeTestHost({ wakeLock: "rejects", videoPlays: false });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();
    await settle();

    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.videos).toHaveLength(1);
  });
});

describe("createWakeLockEngine — release", () => {
  it("releases the sentinel and unsubscribes on unmount", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();
    engine.setActive(false);
    await settle();

    expect(test.release).toHaveBeenCalledTimes(1);
    expect(test.liveListenerCount()).toBe(0);
    expect(engine.getState()).toEqual(IDLE_WAKE_LOCK);
  });

  it("pauses and removes the video on unmount", async () => {
    const test = makeTestHost({ wakeLock: "absent" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();
    engine.setActive(false);
    await settle();

    expect(test.videos[0]?.pause).toHaveBeenCalledTimes(1);
    expect(test.videos[0]?.remove).toHaveBeenCalledTimes(1);
    expect(test.liveListenerCount()).toBe(0);
    expect(engine.getState()).toEqual(IDLE_WAKE_LOCK);
  });

  it("releases a lock that arrives after the board has gone", async () => {
    // The request is in flight when the route unmounts. Without the generation
    // check this installs a sentinel that nothing will ever release.
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    engine.setActive(false);
    await settle();

    expect(test.release).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toEqual(IDLE_WAKE_LOCK);
  });

  it("can be re-activated after a release", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();
    engine.setActive(false);
    await settle();
    engine.setActive(true);
    await settle();

    expect(test.request).toHaveBeenCalledTimes(2);
    expect(engine.getState()).toEqual({ held: true, via: "screen-lock" });
  });
});

describe("createWakeLockEngine — visibilitychange", () => {
  it("re-acquires when the page becomes visible again", async () => {
    // The one everybody forgets: the browser drops the lock on hide, and the
    // sentinel you were handed is dead for good.
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();
    expect(test.request).toHaveBeenCalledTimes(1);

    test.setVisible(false);
    test.fireVisibilityChange();
    test.setVisible(true);
    test.fireVisibilityChange();
    await settle();

    expect(test.request).toHaveBeenCalledTimes(2);
    // The stale sentinel was let go rather than left dangling.
    expect(test.release).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toEqual({ held: true, via: "screen-lock" });
  });

  it("rebuilds the video on wake too, since the OS pauses a backgrounded one", async () => {
    const test = makeTestHost({ wakeLock: "absent" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    test.fireVisibilityChange();
    await settle();

    expect(test.videos).toHaveLength(2);
    expect(test.videos[0]?.remove).toHaveBeenCalledTimes(1);
    expect(test.videos[1]?.play).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toEqual({ held: true, via: "video" });
  });

  it("does nothing on the way to hidden", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();

    test.setVisible(false);
    test.fireVisibilityChange();
    await settle();

    expect(test.request).toHaveBeenCalledTimes(1);
    expect(test.release).not.toHaveBeenCalled();
  });

  it("ignores a visibilitychange that arrives after release", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);

    engine.setActive(true);
    await settle();
    engine.setActive(false);
    await settle();

    // The hook unsubscribed, but a stray call must still be inert.
    test.fireVisibilityChange();
    await settle();

    expect(test.request).toHaveBeenCalledTimes(1);
    expect(engine.getState()).toEqual(IDLE_WAKE_LOCK);
  });
});

describe("createWakeLockEngine — inactive", () => {
  it("does nothing at all while active is false", async () => {
    const test = makeTestHost({ wakeLock: "grants" });
    const engine = createWakeLockEngine(test.host);
    const seen = track(engine);

    // Never activated, then told to deactivate — both are no-ops.
    engine.setActive(false);
    await settle();

    expect(test.request).not.toHaveBeenCalled();
    expect(test.videos).toHaveLength(0);
    expect(test.listeners).toHaveLength(0);
    expect(seen).toEqual([]);
    expect(engine.getState()).toEqual(IDLE_WAKE_LOCK);
  });

  it("starts idle so the server-rendered board reports nothing held", () => {
    const test = makeTestHost();
    expect(createWakeLockEngine(test.host).getState()).toEqual(IDLE_WAKE_LOCK);
  });
});
