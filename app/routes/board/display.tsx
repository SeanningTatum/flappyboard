import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { redirect, useRevalidator } from "react-router";

import type { Route } from "./+types/display";
import { cn } from "@/lib/utils";
import { useBoardSocket } from "@/hooks/use-board-socket";
import { useWakeLock } from "@/hooks/use-wake-lock";
import { createFlapPlayer } from "@/lib/board/sfx";
import { DEFAULT_PAIRING_TTL_SECONDS } from "@/lib/board/pairing";
import {
  createReloadLatch,
  dimOpacity,
  driftOffset,
  shouldReload,
  DRIFT_INTERVAL_MS,
  WATCHDOG_MS,
} from "@/lib/board/kiosk";
import { BoardGridView } from "@/components/board/board-grid-view";
import { BoardOffline } from "@/components/board/board-offline";
import { QrOverlay } from "@/components/board/qr-overlay";
import { SoundUnlockPrompt } from "@/components/board/sound-unlock-prompt";
// The scoped token override for the console surfaces. See the header of that
// file for why this route runs its own visual language.
import "./hardware-theme.css";
import flapFont from "@/assets/fonts/inter-flap-600.woff2?url";

/**
 * `/b/:boardId` — the TV. This route is the board and nothing else: no chrome,
 * no navigation, no scrollbar. Everything that isn't the board (status, QR,
 * sound prompt) lives in a corner and is sized in `vmin` so it stays small on a
 * 65" panel and legible on a laptop.
 */

export const handle = { i18n: ["board"] };

/**
 * The flap face is preloaded per-route rather than in `root.tsx` because only
 * the surfaces that render tiles need it. That is this route, the controller,
 * and — since 2026-07-31 — the landing page, which drives a live board of its
 * own and declares the same preload (`routes/home.tsx`).
 *
 * It is declared `font-display: block`, so the alternative to arriving early is
 * 144 tiles painting nothing until it lands. `crossOrigin` is required even
 * same-origin: fonts fetch in CORS mode, and a preload without it is a
 * different request than the one `@font-face` makes, so the file is fetched
 * twice.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: flapFont,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

/**
 * Only the non-live statuses have copy — a healthy board says nothing. Spelled
 * out as a map rather than an interpolated key so a missing translation is a
 * type error rather than a `status.live` string on a TV.
 */
const STATUS_KEYS = {
  connecting: "status.connecting",
  reconnecting: "status.reconnecting",
  offline: "status.offline",
} as const satisfies Record<string, string>;

/**
 * How often the TV re-mints its pairing token.
 *
 * A third of the token's TTL, so two consecutive ticks can be missed — a throttled
 * background timer, a slow loader — and the QR on screen is still redeemable. A
 * value close to the TTL would leave a window where the code is technically alive
 * but dies mid-walk-across-the-room.
 */
export const QR_REFRESH_MS = Math.floor(
  (DEFAULT_PAIRING_TTL_SECONDS * 1000) / 3
);

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const boardId = params.boardId;

  /*
    Session **or** device grant, via `board.display`.

    This used to be `requireSession`, which meant putting a board on a TV
    required typing an email and a password with a D-pad — the single largest
    piece of friction in the product. A television now reaches this route with
    an `fb_device_<boardId>` cookie and no account at all; the owner's own
    browser still reaches it with a session, and nothing else reaches it.

    Reading through the room (not the latest D1 snapshot) means the TV's first
    paint is already the live board, so the socket has nothing to correct.
  */
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.display({ boardId }),
      catch: (cause) => cause,
    })
  );

  /*
    Every failure sends the screen to `/tv`, and that is a deliberate change from
    the 404 this used to throw.

    The expected cause is cookie eviction: the runtime this feature targets is a
    Samsung television's built-in browser, which clears cookies on its own
    schedule, and the display waking up un-paired is the *normal* end of a
    pairing rather than an error. A 404 on a wall-mounted panel is a dead end
    nobody can act on; `/tv` is a six-character code and two taps on a phone.

    A genuinely unknown or unowned board id lands in the same place, which keeps
    it non-enumerable — the same rule as the tRPC routes and the socket upgrade.
  */
  if (Exit.isFailure(exit)) {
    throw redirect("/tv");
  }

  // `/b/:boardId/c?t=<signed pairing token>` — the QR carries a short-lived,
  // single-use token so a phone can claim the board without already holding the
  // owner's session. Minted inside `board.display`, which is the only place that
  // holds both the caller's proof of authority over this board and the signing
  // secret. Built from the request URL rather than `window.location` so the QR
  // is identical server- and client-side (no hydration flicker).
  const controllerUrl = new URL(
    `/b/${encodeURIComponent(boardId)}/c`,
    request.url
  );
  // A board that can't mint a token is still a working board: fall back to the
  // token-free URL, which the owner's own signed-in phone can still use.
  if (exit.value.pairingToken !== null) {
    controllerUrl.searchParams.set("t", exit.value.pairingToken);
  }

  // Only what the screen needs crosses the wire.
  return {
    boardId,
    state: exit.value.state,
    controllerUrl: controllerUrl.toString(),
  };
}

export default function BoardDisplay({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("board");
  const { boardId, state: initialState, controllerUrl } = loaderData;

  const { grid, revision, soundPack, muted, status } = useBoardSocket({
    boardId,
    initialState,
  });

  const playerRef = useRef<ReturnType<typeof createFlapPlayer> | null>(null);
  const [soundUnlocked, setSoundUnlocked] = useState(false);

  // Built in an effect, never during render: the player touches Web Audio, which
  // does not exist on the server.
  useEffect(() => {
    const player = createFlapPlayer({ packId: soundPack, muted });
    playerRef.current = player;
    setSoundUnlocked(player.isUnlocked());
    return () => {
      playerRef.current = null;
    };
    // Pack and mute are pushed in below; re-creating the player on a settings
    // change would throw away the audio unlock the user already granted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The phone owns these two settings; the TV just follows the state event.
  useEffect(() => {
    playerRef.current?.setPack(soundPack);
  }, [soundPack]);

  useEffect(() => {
    playerRef.current?.setMuted(muted);
  }, [muted]);

  const unlockSound = useCallback(() => {
    const player = playerRef.current;
    if (player === null) return;
    if (player.isUnlocked()) {
      setSoundUnlocked(true);
      return;
    }
    void player.unlock().then((allowed) => {
      if (allowed) setSoundUnlocked(true);
    });
  }, []);

  /**
   * One gesture, two jobs: unlock the audio and go fullscreen.
   *
   * They ride the same handler rather than getting one each because they are
   * gated on the same scarce thing. Both Web Audio and the Fullscreen API
   * require a user gesture, and on a wall-mounted TV there may never be another
   * one after setup — so the first press of the remote's OK button has to spend
   * itself on both or one of them never happens at all.
   *
   * Fullscreen is attempted once and its refusal is ignored. Decision 2 put this
   * in a browser with no kiosk mode, and the plan accepts that browser chrome
   * may simply remain visible: a bar at the top of the screen is not a failure
   * worth surfacing to a room with nobody in it.
   */
  const fullscreenTried = useRef(false);
  const requestFullscreen = useCallback(() => {
    if (fullscreenTried.current) return;
    fullscreenTried.current = true;
    const element = document.documentElement;
    if (document.fullscreenElement !== null) return;
    if (typeof element.requestFullscreen !== "function") return;
    // No `catch` branch on purpose — see above.
    void Promise.resolve()
      .then(() => element.requestFullscreen())
      .catch(() => undefined);
  }, []);

  // Any gesture counts, not just the prompt — a TV remote's OK button arrives as
  // a keydown, and that is the only input most of these screens will ever get.
  useEffect(() => {
    const onGesture = () => {
      if (!soundUnlocked) unlockSound();
      requestFullscreen();
    };
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [soundUnlocked, unlockSound, requestFullscreen]);

  /**
   * Keep the panel awake for as long as this route is mounted.
   *
   * `navigator.wakeLock` is feature-detected inside the hook, but the
   * silent-looping-muted-video fallback is written as the primary path, because
   * the runtime this targets most likely does not implement the API at all. If
   * both fail the hook reports `via: "none"` and says nothing further — a
   * sleeping TV is not an error worth shouting about.
   */
  useWakeLock(true);

  /**
   * Burn-in drift.
   *
   * A few pixels on a slow cycle, applied as a transform on the grid rather than
   * as layout, so it cannot reflow anything or produce the scrollbar the
   * verification asserts against (`scrollable=false`). The container is
   * `overflow-hidden`, so the movement is invisible at the edges too.
   */
  const [driftTick, setDriftTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(
      () => setDriftTick((tick) => tick + 1),
      DRIFT_INTERVAL_MS
    );
    return () => clearInterval(timer);
  }, []);
  const drift = driftOffset(driftTick);

  /**
   * Idle dim: the board is still readable at 3am, just no longer the brightest
   * thing in the room. Re-evaluated every minute rather than scheduled to the
   * boundary, so a suspended tab that wakes at 23:30 dims immediately instead of
   * waiting for a timer that never fired.
   */
  const [localHour, setLocalHour] = useState(() => new Date().getHours());
  useEffect(() => {
    const timer = setInterval(() => setLocalHour(new Date().getHours()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const opacity = dimOpacity(localHour);

  /**
   * The watchdog. One hard reload after the socket has been dead past the
   * threshold — one per *outage*, never a loop. The rule lives in
   * `shouldReload` and `createReloadLatch` and is unit-tested there; what
   * matters here is that the latch is kept in `sessionStorage`, because the
   * thing it gates is `window.location.reload()` and a page-lifetime ref is
   * reset by exactly that call — the measured result of the ref was a reload
   * every two minutes for the whole outage. The latch survives the reload, and
   * is cleared once the socket is live again so the next outage earns its own.
   * This is for the overnight failure the reconnect loop cannot fix by itself:
   * a redeployed worker, a rebooted router, a socket wedged open but dead,
   * with nobody awake to press anything.
   */
  const downSince = useRef<number | null>(null);
  useEffect(() => {
    /*
      Even *reading* `window.sessionStorage` can throw (storage disabled in the
      browser), so the read goes through `Effect.try`. An unreachable store
      yields `undefined` and the latch degrades to "never reload" — a stale
      board is always better than a crash, or a reload the page cannot remember.
    */
    const storage = Effect.runSync(
      Effect.try(() => window.sessionStorage).pipe(
        Effect.orElseSucceed(() => undefined)
      )
    );
    const reloadLatch = createReloadLatch(storage);

    if (status === "live") {
      downSince.current = null;
      // Recovery re-arms the watchdog: the next outage gets its own reload.
      reloadLatch.clear();
      return;
    }
    if (downSince.current === null) downSince.current = Date.now();

    const timer = setInterval(() => {
      if (
        !shouldReload({
          status,
          downSince: downSince.current,
          now: Date.now(),
          reloaded: reloadLatch.isLatched(),
        })
      ) {
        return;
      }
      // Reload only if the latch could be persisted — otherwise the reloaded
      // page would not remember it spent its one reload, and would loop.
      if (reloadLatch.latch()) window.location.reload();
    }, Math.floor(WATCHDOG_MS / 4));

    return () => clearInterval(timer);
  }, [status]);

  /**
   * Keep the QR redeemable. The loader mints a ~120s single-use pairing token, so
   * a TV left on screen would otherwise be showing a dead code within minutes —
   * someone walks up, scans, and lands on the rescan prompt.
   *
   * `revalidate()` re-runs the loader, which is the only place that can mint a
   * token (it holds the owner's session and the Workers env). It cannot disturb the
   * board: `loaderData.state` is only ever read as `useBoardSocket`'s `initialState`,
   * which is a `useState` initialiser and therefore ignored after mount, and
   * `boardId` never changes — so the socket is not rebuilt, the grid keeps coming
   * from the socket, and no tile re-flips. Only `controllerUrl` moves.
   *
   * Suspend/wake: a suspended tab freezes (or heavily throttles) timers, so the
   * interval alone would come back late with an already-dead token. The
   * `visibilitychange` listener refreshes immediately on wake, which is the case
   * that actually matters on a TV — and it is why the interval skips a hidden tab
   * rather than firing into one. `setInterval` + `visibilitychange` and nothing
   * else, so this works on a Tizen browser.
   */
  const revalidator = useRevalidator();
  // The revalidator's identity changes with its state; a ref keeps the effect
  // mount-only instead of tearing the timer down on every revalidation.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      // Never stack revalidations: a slow loader would otherwise queue a burst.
      if (revalidatorRef.current.state !== "idle") return;
      void revalidatorRef.current.revalidate();
    };

    const timer = setInterval(refresh, QR_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /**
   * The clatter. A real board rattles for the whole time its tiles are turning
   * and thins out as they land, so the sound is driven from the same loop as the
   * animation rather than fired once per grid change: `BoardGridView` reports how
   * many tiles are still moving on every frame, and `tick` turns that into a
   * bounded clack rate that falls as the count does (see `FlapPlayer.tick`).
   *
   * A resync or a settings-only frame re-broadcasts an identical grid, which
   * plans no motion at all, so it reports 0 and stays silent — a TV that clacked
   * every time it woke up would be worse than a silent one. Mute and the autoplay
   * gate are both enforced inside the player, so this fires throughout either way
   * and the animation is never coupled to whether sound is allowed.
   */
  const onMotion = useCallback((movingCells: number) => {
    playerRef.current?.tick(movingCells);
  }, []);

  return (
    <main
      data-surface="hardware"
      className="relative flex h-screen w-screen items-center justify-center overflow-hidden bg-black"
      data-testid="board-display"
      data-status={status}
      // Exposed so a test (or a human squinting at a wall-mounted TV) can read
      // how far the board has advanced without opening a socket to ask.
      data-revision={revision}
      // Settings arrive on a state frame at an *unchanged* revision, which makes
      // "did the phone's mute reach the TV?" otherwise invisible from the DOM —
      // phase 4 verification had to capture WebSocket frames to prove it. These
      // two make the same fact assertable without a socket listener.
      data-muted={muted ? "true" : "false"}
      data-sound-pack={soundPack}
      // Both kiosk behaviours are exposed so the soak run can assert them from
      // the DOM instead of inferring them from a photograph of a television.
      data-drift={`${drift.x},${drift.y}`}
      data-dimmed={opacity < 1 ? "true" : "false"}
    >
      {/*
        Drift and dim are applied to a wrapper, never to the grid's own layout:
        a transform cannot reflow, so the 24×6 geometry and the
        `scrollable=false` assertion both survive with drift active.
      */}
      <div
        className="transition-opacity duration-1000"
        style={{
          transform: `translate3d(${drift.x}px, ${drift.y}px, 0)`,
          opacity,
        }}
      >
        <BoardGridView grid={grid} onMotion={onMotion} />
      </div>

      {/*
        The last grid stays on screen while the socket is down — a split-flap
        board holding its last message is correct. The spinner is a scrim over
        it, so the board never pretends to be live and never goes blank either.
      */}
      <BoardOffline status={status} />

      {/*
        A blip must never take the board away, so the connection state is a dim
        dot in a corner and nothing more. A live board renders nothing at all.
      */}
      {status !== "live" && (
        <div
          className="absolute top-[2vmin] left-[2vmin] flex items-center gap-[1vmin] rounded-full bg-neutral-900/80 px-[1.6vmin] py-[0.8vmin]"
          data-testid="board-status-chip"
          role="status"
        >
          <span
            className={cn(
              "size-[1.2vmin] rounded-full",
              status === "offline" ? "bg-red-500" : "bg-yellow-400"
            )}
            aria-hidden
          />
          <span className="text-[1.6vmin] font-medium tracking-wide text-neutral-300 uppercase">
            {t(STATUS_KEYS[status])}
          </span>
        </div>
      )}

      <QrOverlay url={controllerUrl} className="absolute right-[2vmin] bottom-[2vmin]" />

      <SoundUnlockPrompt
        unlocked={soundUnlocked}
        onUnlock={unlockSound}
        className="absolute bottom-[2vmin] left-[2vmin]"
      />
    </main>
  );
}

/**
 * A kiosk-appropriate error state. Without this, a bad board id renders React
 * Router's default boundary: a bare full-white page with an empty title, which
 * on a wall-mounted TV in a dark room is a flashbang. Same dark field as the
 * board, no stack trace on screen (it stays in the server log) — the only thing
 * a passer-by can act on is the address.
 */
export function ErrorBoundary() {
  const { t } = useTranslation("board");
  return (
    <main
      data-surface="hardware"
      className="flex h-screen w-screen flex-col items-center justify-center gap-[2vmin] overflow-hidden bg-black text-center"
      data-testid="board-error"
    >
      <p className="text-[4vmin] font-semibold tracking-wide text-neutral-200 uppercase">
        {t("error.title")}
      </p>
      <p className="max-w-[60vw] text-[2.2vmin] text-neutral-500">{t("error.body")}</p>
    </main>
  );
}
