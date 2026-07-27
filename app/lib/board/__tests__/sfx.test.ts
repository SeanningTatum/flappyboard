import { describe, expect, it } from "vitest";
import {
  CLATTER_BASE_MS,
  CLATTER_MAX_INTERVAL_MS,
  CLATTER_MIN_INTERVAL_MS,
  DEFAULT_SOUND_PACK_ID,
  SOUND_PACKS,
  clatterIntervalMs,
  createFlapPlayer,
  resolveSoundPack,
  type AudioFactory,
  type AudioLike,
} from "../sfx";

class FakeAudio implements AudioLike {
  currentTime = 0;
  volume = 1;
  playbackRate = 1;
  src = "";
  playCalls = 0;
  pauseCalls = 0;
  /** Every rate/level the element was asked to play at, in order. */
  readonly rates: number[] = [];
  readonly levels: number[] = [];
  /** Flip to "reject" to simulate the browser refusing autoplay. */
  behavior: "resolve" | "reject" = "resolve";

  play(): Promise<void> {
    this.playCalls += 1;
    this.rates.push(this.playbackRate);
    this.levels.push(this.volume);
    return this.behavior === "resolve"
      ? Promise.resolve()
      : Promise.reject(new Error("NotAllowedError"));
  }

  pause(): void {
    this.pauseCalls += 1;
  }
}

const makePool = (): { factory: AudioFactory; instances: FakeAudio[] } => {
  const instances: FakeAudio[] = [];
  const factory: AudioFactory = () => {
    const audio = new FakeAudio();
    instances.push(audio);
    return audio;
  };
  return { factory, instances };
};

describe("SOUND_PACKS / resolveSoundPack", () => {
  it("has exactly a classic and a soft pack", () => {
    expect(SOUND_PACKS.map((pack) => pack.id).sort()).toEqual(["classic", "soft"]);
  });

  it("defaults to classic", () => {
    expect(DEFAULT_SOUND_PACK_ID).toBe("classic");
    expect(SOUND_PACKS.some((pack) => pack.id === DEFAULT_SOUND_PACK_ID)).toBe(true);
  });

  it("resolves a known id", () => {
    expect(resolveSoundPack("soft").id).toBe("soft");
    expect(resolveSoundPack("classic").id).toBe("classic");
  });

  it("falls back to classic for an unknown id", () => {
    expect(resolveSoundPack("banjo").id).toBe("classic");
  });

  it("falls back to classic for an empty string", () => {
    expect(resolveSoundPack("").id).toBe("classic");
  });

  it("falls back to classic for a non-string value — the phone payload can send anything", () => {
    expect(resolveSoundPack(123 as unknown as string).id).toBe("classic");
    expect(resolveSoundPack(null as unknown as string).id).toBe("classic");
    expect(resolveSoundPack(undefined as unknown as string).id).toBe("classic");
    expect(resolveSoundPack({} as unknown as string).id).toBe("classic");
  });

  it("never throws for any input", () => {
    expect(() => resolveSoundPack("banjo")).not.toThrow();
    expect(() => resolveSoundPack({} as unknown as string)).not.toThrow();
  });
});

describe("createFlapPlayer", () => {
  it("starts locked: play() is a no-op before unlock()", () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });

    expect(player.isUnlocked()).toBe(false);
    player.play();
    for (const audio of instances) expect(audio.playCalls).toBe(0);
  });

  it("unlock() resolves true and flips isUnlocked() when play() succeeds", async () => {
    const { factory } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });

    await expect(player.unlock()).resolves.toBe(true);
    expect(player.isUnlocked()).toBe(true);
  });

  it("unlock() is idempotent and doesn't re-probe once already unlocked", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });

    await player.unlock();
    await player.unlock();
    for (const audio of instances) expect(audio.playCalls).toBe(1);
  });

  it("unlock() pauses and rewinds every pooled element instead of leaving audible probes", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });

    await player.unlock();
    expect(instances.length).toBeGreaterThan(0);
    for (const audio of instances) {
      expect(audio.playCalls).toBe(1);
      expect(audio.pauseCalls).toBe(1);
      expect(audio.currentTime).toBe(0);
      expect(audio.volume).toBe(1); // restored after the silent probe
    }
  });

  it("unlock() resolves false and stays locked when the browser refuses autoplay", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });
    for (const audio of instances) audio.behavior = "reject";

    await expect(player.unlock()).resolves.toBe(false);
    expect(player.isUnlocked()).toBe(false);
  });

  it("play() stays a no-op after a failed unlock", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });
    for (const audio of instances) audio.behavior = "reject";
    await player.unlock();

    player.play();
    for (const audio of instances) expect(audio.playCalls).toBe(1); // only the unlock attempt
  });

  it("play() calls through once unlocked, and swallows a rejection without throwing", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });
    await player.unlock();

    const audio = instances[0]!;
    audio.behavior = "reject";
    expect(() => player.play()).not.toThrow();
    expect(audio.playCalls).toBe(2); // one from unlock, one from play()
  });

  it("play() is a no-op once muted, even when unlocked", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });
    await player.unlock();
    player.setMuted(true);

    player.play();
    for (const audio of instances) expect(audio.playCalls).toBe(1); // unlock only
  });

  it("respects muted: true passed at construction", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: true,
      audioFactory: factory,
    });
    await player.unlock();

    player.play();
    for (const audio of instances) expect(audio.playCalls).toBe(1); // unlock only
  });

  it("play() cycles round-robin through a bounded pool instead of growing unbounded", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });
    await player.unlock();

    const poolSize = instances.length;
    for (let i = 0; i < poolSize * 3; i++) player.play();

    // No new audio objects were ever created past construction.
    expect(instances.length).toBe(poolSize);
    // Every pooled element got its fair share (round robin, not just element 0).
    for (const audio of instances) {
      expect(audio.playCalls).toBe(1 /* unlock */ + 3 /* 3 full cycles */);
    }
  });

  it("setPack() updates every pooled element's src; unknown id falls back to classic", () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });

    player.setPack("soft");
    const softUrl = resolveSoundPack("soft").flapUrl;
    for (const audio of instances) expect(audio.src).toBe(softUrl);

    player.setPack("nonsense-pack");
    const classicUrl = resolveSoundPack("classic").flapUrl;
    for (const audio of instances) expect(audio.src).toBe(classicUrl);
  });

  it("applies the initial packId's src at construction", () => {
    const { factory, instances } = makePool();
    createFlapPlayer({ packId: "soft", muted: false, audioFactory: factory });

    const softUrl = resolveSoundPack("soft").flapUrl;
    for (const audio of instances) expect(audio.src).toBe(softUrl);
  });

  it("is safe to construct with the default (browser) audio factory outside a browser", () => {
    // This test's environment has no `Audio` global at all (vitest runs
    // "node", not jsdom) — constructing without an injected factory exercises
    // the real SSR-safety guard, not a fake standing in for it.
    expect(() => createFlapPlayer({ packId: "classic", muted: false })).not.toThrow();

    const player = createFlapPlayer({ packId: "classic", muted: false });
    expect(() => player.play()).not.toThrow();
    expect(() => player.setPack("soft")).not.toThrow();
    expect(() => player.setMuted(true)).not.toThrow();
    expect(() => player.tick(144)).not.toThrow();
    expect(() => player.stopClatter()).not.toThrow();
  });

  it("varies pitch and level per clack instead of firing an identical sample", async () => {
    const { factory, instances } = makePool();
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
    });
    await player.unlock();

    for (let i = 0; i < 24; i++) player.play();

    const rates = instances.flatMap((audio) => audio.rates.slice(1));
    const levels = instances.flatMap((audio) => audio.levels.slice(1));
    expect(rates).toHaveLength(24);
    expect(new Set(rates).size).toBeGreaterThan(20);
    expect(new Set(levels).size).toBeGreaterThan(20);
    // Bounded: pitch stays within ±8%, level within the top 18%.
    for (const rate of rates) {
      expect(rate).toBeGreaterThanOrEqual(0.92);
      expect(rate).toBeLessThanOrEqual(1.08);
    }
    for (const level of levels) {
      expect(level).toBeGreaterThanOrEqual(0.82);
      expect(level).toBeLessThanOrEqual(1);
    }
  });
});

describe("clatterIntervalMs", () => {
  it("is Infinity when nothing is moving — the natural 'never due'", () => {
    expect(clatterIntervalMs(0)).toBe(Number.POSITIVE_INFINITY);
    expect(clatterIntervalMs(-3)).toBe(Number.POSITIVE_INFINITY);
  });

  it("never throws and never returns NaN for hostile input", () => {
    expect(clatterIntervalMs(Number.NaN)).toBe(Number.POSITIVE_INFINITY);
    expect(clatterIntervalMs(Number.POSITIVE_INFINITY)).toBe(
      Number.POSITIVE_INFINITY
    );
    expect(clatterIntervalMs("144" as unknown as number)).toBe(
      Number.POSITIVE_INFINITY
    );
  });

  it("is capped: a full board cannot clack faster than the rate cap", () => {
    expect(clatterIntervalMs(144)).toBe(CLATTER_MIN_INTERVAL_MS);
    expect(clatterIntervalMs(1_000_000)).toBe(CLATTER_MIN_INTERVAL_MS);
    // ~22 clacks/second, not ~2,000.
    expect(1_000 / clatterIntervalMs(144)).toBeLessThan(25);
  });

  it("is floored: one tile still turning still clicks rather than going silent", () => {
    expect(clatterIntervalMs(1)).toBe(CLATTER_MAX_INTERVAL_MS);
  });

  it("thins monotonically as tiles land", () => {
    const counts = [144, 100, 64, 36, 25, 16, 9, 4, 1];
    const intervals = counts.map(clatterIntervalMs);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i]!).toBeGreaterThanOrEqual(intervals[i - 1]!);
    }
    // And it genuinely thins over the tail rather than clamping flat.
    expect(clatterIntervalMs(4)).toBeGreaterThan(clatterIntervalMs(36) * 2);
  });

  it("follows base/sqrt(moving) inside the clamped band", () => {
    expect(clatterIntervalMs(16)).toBeCloseTo(CLATTER_BASE_MS / 4, 6);
  });
});

describe("createFlapPlayer clatter", () => {
  const drive = async (opts: { muted?: boolean }) => {
    const { factory, instances } = makePool();
    let now = 0;
    const player = createFlapPlayer({
      packId: "classic",
      muted: opts.muted ?? false,
      audioFactory: factory,
      now: () => now,
    });
    await player.unlock();
    const unlockCalls = instances.reduce((sum, a) => sum + a.playCalls, 0);
    const clacks = () =>
      instances.reduce((sum, a) => sum + a.playCalls, 0) - unlockCalls;
    return { player, clacks, at: (t: number) => (now = t) };
  };

  it("clacks immediately at the start of a burst", async () => {
    const { player, clacks, at } = await drive({});
    at(0);
    player.tick(144);
    expect(clacks()).toBe(1);
  });

  it("emits at most one clack per tick, however often it is called", async () => {
    const { player, clacks, at } = await drive({});
    at(0);
    for (let i = 0; i < 10; i++) player.tick(144);
    expect(clacks()).toBe(1);
  });

  it("holds the rate cap over a full-board burst instead of one clack per flap", async () => {
    const { player, clacks, at } = await drive({});
    // 4 seconds of 60Hz frames with the whole board moving.
    for (let frame = 0; frame * 16 <= 4_000; frame++) {
      at(frame * 16);
      player.tick(144);
    }
    // 4s at the 45ms cap is ~89 clacks; frame granularity rounds it down a
    // little. What matters is the order of magnitude: ~90, not ~8,000.
    expect(clacks()).toBeGreaterThan(60);
    expect(clacks()).toBeLessThan(100);
  });

  it("thins to a trickle as tiles land: the tail is quieter than the opening", async () => {
    const { player, clacks, at } = await drive({});
    let t = 0;
    const window = (moving: number, ms: number): number => {
      const before = clacks();
      const end = t + ms;
      for (; t <= end; t += 16) {
        at(t);
        player.tick(moving);
      }
      return clacks() - before;
    };
    const dense = window(144, 500);
    const thin = window(3, 500);
    expect(dense).toBeGreaterThan(thin * 3);
    expect(thin).toBeGreaterThan(0); // still clicking, not silent
  });

  it("tick(0) ends the burst, and the next burst clacks immediately", async () => {
    const { player, clacks, at } = await drive({});
    at(0);
    player.tick(144);
    at(10);
    player.tick(0);
    expect(clacks()).toBe(1);
    // 11ms later — well inside the cap — a *new* burst still gets its opening clack.
    at(11);
    player.tick(144);
    expect(clacks()).toBe(2);
  });

  it("stopClatter() does the same thing explicitly", async () => {
    const { player, clacks, at } = await drive({});
    at(0);
    player.tick(144);
    player.stopClatter();
    at(5);
    player.tick(144);
    expect(clacks()).toBe(2);
  });

  it("is silent while muted, even though the animation keeps ticking", async () => {
    const { player, clacks, at } = await drive({ muted: true });
    for (let frame = 0; frame < 100; frame++) {
      at(frame * 16);
      player.tick(144);
    }
    expect(clacks()).toBe(0);
  });

  it("is silent before unlock, even though the animation keeps ticking", () => {
    const { factory, instances } = makePool();
    let now = 0;
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
      now: () => now,
    });
    for (let frame = 0; frame < 100; frame++) {
      now = frame * 16;
      player.tick(144);
    }
    for (const audio of instances) expect(audio.playCalls).toBe(0);
  });

  it("never allocates past the pool, however long the clatter runs", async () => {
    const { factory, instances } = makePool();
    let now = 0;
    const player = createFlapPlayer({
      packId: "classic",
      muted: false,
      audioFactory: factory,
      now: () => now,
    });
    await player.unlock();
    const poolSize = instances.length;
    for (let frame = 0; frame < 2_000; frame++) {
      now = frame * 16;
      player.tick(144);
    }
    expect(instances.length).toBe(poolSize);
  });

  it("uses its own injected clock rather than wall time", async () => {
    const { player, clacks, at } = await drive({});
    at(0);
    player.tick(1); // ceiling interval: 260ms
    at(259);
    player.tick(1);
    expect(clacks()).toBe(1);
    at(260);
    player.tick(1);
    expect(clacks()).toBe(2);
  });

  it("ignores a non-finite clock reading rather than clacking every frame", async () => {
    const { player, clacks } = await drive({});
    player.tick(144, Number.NaN);
    expect(clacks()).toBe(0);
  });
});
