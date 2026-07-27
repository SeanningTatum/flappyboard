import { useCallback, useEffect, useRef, useState } from "react";
import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { useRevalidator } from "react-router";

import type { Route } from "./+types/display";
import { requireSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useBoardSocket } from "@/hooks/use-board-socket";
import { createFlapPlayer } from "@/lib/board/sfx";
import {
  DEFAULT_PAIRING_TTL_SECONDS,
  mintPairingToken,
} from "@/lib/board/pairing";
import { BoardGridView } from "@/components/board/board-grid-view";
import { QrOverlay } from "@/components/board/qr-overlay";
import { SoundUnlockPrompt } from "@/components/board/sound-unlock-prompt";

/**
 * `/b/:boardId` — the TV. This route is the board and nothing else: no chrome,
 * no navigation, no scrollbar. Everything that isn't the board (status, QR,
 * sound prompt) lives in a corner and is sized in `vmin` so it stays small on a
 * 65" panel and legible on a laptop.
 */

export const handle = { i18n: ["board"] };

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
  await requireSession(request, context);

  const boardId = params.boardId;

  // Reading through the room (not the latest D1 snapshot) means the TV's first
  // paint is already the live board, so the socket has nothing to correct.
  const exit = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.get({ boardId }),
      catch: (cause) => cause,
    })
  );

  // Missing, not-owned, and "the room is unreachable" all collapse to 404 here.
  // On a kiosk surface the distinction is not actionable — there is nobody to
  // read an error page, and a transient failure resolves on the next reload —
  // while a 404 keeps an unowned board id non-enumerable, same rule as the
  // tRPC routes and the socket upgrade.
  if (Exit.isFailure(exit)) {
    throw new Response(null, { status: 404, statusText: "Board not found" });
  }

  // `/b/:boardId/c?t=<signed pairing token>` — the QR carries a short-lived,
  // single-use token so a phone can claim the board without already holding the
  // owner's session. Minted here because this loader is the only place that holds
  // both the owner's session (proving the QR is theirs to print) and the Workers
  // env; tRPC's context carries neither. Built from the request URL rather than
  // `window.location` so the QR is identical server- and client-side (no
  // hydration flicker).
  const controllerUrl = new URL(
    `/b/${encodeURIComponent(boardId)}/c`,
    request.url
  );
  // `grantEpoch` comes off the row we just read, so the QR is always minted at
  // the board's current epoch: after the owner revokes controllers, the next
  // re-mint tick (`QR_REFRESH_MS`) prints a code that works again, and the codes
  // printed before it stay dead.
  const minted = await Effect.runPromiseExit(
    mintPairingToken({
      boardId,
      grantEpoch: exit.value.board.grantEpoch,
      secret: context.cloudflare.env.BETTER_AUTH_SECRET,
      now: Date.now(),
    })
  );
  // A board that can't mint a token is still a working board: fall back to the
  // token-free URL, which the owner's own signed-in phone can still use.
  if (Exit.isSuccess(minted)) {
    controllerUrl.searchParams.set("t", minted.value);
  }

  // Only what the screen needs crosses the wire. The board row itself was read
  // purely to prove ownership, and it carries `ownerId` — no reason to ship it.
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

  // Any gesture counts, not just the prompt — a TV remote's OK button arrives as
  // a keydown, and that is the only input most of these screens will ever get.
  useEffect(() => {
    if (soundUnlocked) return;
    const onGesture = () => unlockSound();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [soundUnlocked, unlockSound]);

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
    >
      <BoardGridView grid={grid} onMotion={onMotion} />

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
