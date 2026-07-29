import { useEffect, useRef, useState } from "react";
import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { useRevalidator } from "react-router";

import type { Route } from "./+types/tv";
import { DEVICE_CODE_TTL_SECONDS } from "@/lib/board/device-code";

/**
 * `/tv` — the one URL a television ever has to be told.
 *
 * A display arrives here holding nothing: no account, no cookie, no board. It is
 * shown a six-character code and it opens a socket to the room that code names;
 * the owner types the code into `/link` on a phone that *is* signed in, and the
 * approval arrives here as a pushed frame. The TV then makes one ordinary
 * request to `/tv/claim` to bank the credential as a cookie, because a socket
 * frame cannot `Set-Cookie`.
 *
 * It is the mirror image of the QR flow: there the TV holds the session and
 * hands authority to a phone, here the phone holds the session and hands
 * authority to the TV. Same HMAC surface, opposite direction.
 *
 * Everything on this page is sized in `vmin` and typed for a living room. The
 * only input this screen will ever get is a remote control, so there is nothing
 * to click.
 */

export const handle = { i18n: ["board"] };

/**
 * Draw a fresh code a little before the current one dies, so the number on
 * screen is always redeemable. Two thirds of the TTL — far enough from the edge
 * that a walk from the sofa to the phone cannot lose the race, and infrequent
 * enough that a display left up for a month is not churning rooms.
 */
export const CODE_REFRESH_MS = Math.floor(
  (DEVICE_CODE_TTL_SECONDS * 1000 * 2) / 3
);

export async function loader({ context }: Route.LoaderArgs) {
  const issued = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.issueDeviceCode(),
      catch: (cause) => cause,
    })
  );

  // A code that could not be drawn is not an error page. The screen says so and
  // the refresh timer tries again — on a wall-mounted panel there is nobody to
  // read a stack trace, and the fix is always "wait a moment".
  if (Exit.isFailure(issued)) {
    return { code: null, watcher: null };
  }

  return { code: issued.value.code, watcher: issued.value.watcher };
}

export default function TvPairing({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("board");
  const { code, watcher } = loaderData;
  const [failed, setFailed] = useState(false);

  const revalidator = useRevalidator();
  // The revalidator's identity changes with its state; a ref keeps the effects
  // below mount-stable instead of tearing their timers down on every draw.
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  /** Draw a new code, unless one is already on its way. */
  const redraw = useRef(() => {
    if (revalidatorRef.current.state !== "idle") return;
    void revalidatorRef.current.revalidate();
  }).current;

  /**
   * Rotate the code before it expires, and immediately on waking.
   *
   * The `visibilitychange` half is the one that matters on a TV: a suspended tab
   * freezes its timers, so a panel switched back to this input after an hour
   * would otherwise be displaying a code that died fifty-five minutes ago.
   * `setInterval` plus `visibilitychange` and nothing else, so this works on
   * Tizen's browser.
   */
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      redraw();
    }, CODE_REFRESH_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") redraw();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [redraw]);

  /**
   * Hold the socket that the approval arrives on.
   *
   * The socket is torn down and rebuilt whenever the code changes, because the
   * code *is* the address — a socket held open against the previous room would
   * be listening for an approval nobody can send. Closing it also tells that
   * room its TV has gone, which is what expires the abandoned code early.
   *
   * A close is not treated as an error: the room drops a pending code when its
   * last watcher leaves, so the honest response to any disconnect is to draw a
   * new code rather than to reconnect to a room that may no longer hold one.
   */
  useEffect(() => {
    if (code === null || watcher === null) return;

    const url = new URL("/api/tv-ws", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("code", code);
    url.searchParams.set("watcher", watcher);

    let closed = false;
    const socket = new WebSocket(url.toString());

    socket.addEventListener("message", (event) => {
      const frame = readApproval(event.data);
      if (frame === null) return;
      closed = true;
      // A full navigation, not a client-side one. `/tv/claim` answers with a
      // redirect carrying `Set-Cookie`, and the point of the whole exercise is
      // that the browser banks that cookie against this origin.
      window.location.href = `/tv/claim?board=${encodeURIComponent(
        frame.boardId
      )}&handoff=${encodeURIComponent(frame.handoff)}`;
    });

    socket.addEventListener("close", () => {
      if (closed) return;
      redraw();
    });

    socket.addEventListener("error", () => setFailed(true));

    return () => {
      closed = true;
      // 1000: an ordinary goodbye. The room reads it as "this TV is done with
      // that code" and lets the code go.
      if (socket.readyState <= WebSocket.OPEN) socket.close(1000, "rotating");
    };
  }, [code, watcher, redraw]);

  const unavailable = code === null || failed;

  return (
    <main
      className="flex h-screen w-screen flex-col items-center justify-center gap-[3vmin] overflow-hidden bg-black text-center"
      data-testid="tv-pairing"
      data-state={unavailable ? "unavailable" : "waiting"}
    >
      <p className="text-[2.4vmin] tracking-[0.3em] text-neutral-500 uppercase">
        {t("tv.title")}
      </p>

      {unavailable ? (
        <p className="max-w-[70vw] text-[3vmin] text-neutral-400">
          {t("tv.unavailable")}
        </p>
      ) : (
        <p
          className="font-mono text-[16vmin] leading-none font-bold tracking-[0.15em] text-white tabular-nums"
          data-testid="tv-code"
        >
          {code}
        </p>
      )}

      <p className="max-w-[70vw] text-[2.6vmin] leading-relaxed text-neutral-400">
        {t("tv.instructions")}
      </p>
    </main>
  );
}

interface ApprovalFrame {
  readonly boardId: string;
  readonly handoff: string;
}

/**
 * The one frame this page understands. Total and defensive for the usual reason
 * — it is parsing something off a socket — and narrow on purpose: anything that
 * is not a well-formed approval is ignored rather than acted on.
 */
export const readApproval = (raw: unknown): ApprovalFrame | null => {
  if (typeof raw !== "string") return null;
  const parsed = Effect.runSync(
    Effect.either(Effect.try(() => JSON.parse(raw) as unknown))
  );
  if (parsed._tag === "Left") return null;
  const value = parsed.right;
  if (typeof value !== "object" || value === null) return null;
  const frame = value as Record<string, unknown>;
  if (frame.type !== "approved") return null;
  if (typeof frame.boardId !== "string" || frame.boardId.length === 0) {
    return null;
  }
  if (typeof frame.handoff !== "string" || frame.handoff.length === 0) {
    return null;
  }
  return { boardId: frame.boardId, handoff: frame.handoff };
};
