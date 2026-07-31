import { useEffect, useRef, useState } from "react";
import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { useRevalidator } from "react-router";
import QRCode from "qrcode";

import type { Route } from "./+types/tv";
import { DEVICE_CODE_TTL_SECONDS } from "@/lib/board/device-code";
import { CONSOLE, PLATE_LIP } from "@/components/board/console";
// The scoped token override for the console surfaces. See the header of that
// file for why this route runs its own visual language.
import "./board/hardware-theme.css";

/**
 * `/tv` — the one URL a television ever has to be told.
 *
 * A display arrives here holding nothing: no account, no cookie, no board. It
 * is shown a QR code (with a six-character fallback) and it opens a socket to
 * the room that code names; the owner scans the QR into `/link` on a phone that
 * *is* signed in — signing in first if they are not — and the approval arrives
 * here as a pushed frame. The TV then makes one ordinary request to `/tv/claim`
 * to bank the credential as a cookie, because a socket frame cannot
 * `Set-Cookie`.
 *
 * It is the mirror image of the board's controller QR flow: there the TV holds
 * the session and hands authority to a phone, here the phone holds the session
 * and hands authority to the TV. Same HMAC surface, opposite direction.
 *
 * Everything on this page is sized in `vmin` and typed for a living room. The
 * only input this screen will ever get is a remote control, so there is nothing
 * to click.
 */

export const handle = { i18n: ["board"] };

/**
 * This screen is always a dark object in a dark room — declare it, so the TV
 * browser's own chrome (scrollbars, form controls, the address bar's
 * `theme-color`) stops assuming a white page.
 */
export const meta: Route.MetaFunction = () => [
  { name: "color-scheme", content: "dark" },
  { name: "theme-color", content: CONSOLE.field },
];

/**
 * Draw a fresh code a little before the current one dies, so the QR on screen
 * is always redeemable. Two thirds of the TTL — far enough from the edge that a
 * walk from the sofa to the phone cannot lose the race, and infrequent enough
 * that a display left up for a month is not churning rooms.
 */
export const CODE_REFRESH_MS = Math.floor(
  (DEVICE_CODE_TTL_SECONDS * 1000 * 2) / 3
);

/**
 * The URL the QR encodes: `/link` with the code already in the query, so a scan
 * lands the owner on the approval page with nothing left to type. Absolute —
 * a QR has no concept of "relative to this page" — and built from the request
 * so it is right on localhost, preview and production alike.
 */
export const tvLinkUrl = (href: string, code: string): string => {
  const url = new URL("/link", href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("code", code);
  return url.toString();
};

export async function loader({ request, context }: Route.LoaderArgs) {
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
    return { code: null, watcher: null, linkUrl: null };
  }

  return {
    code: issued.value.code,
    watcher: issued.value.watcher,
    linkUrl: tvLinkUrl(request.url, issued.value.code),
  };
}

/** Rendered at 2× the on-screen size so a TV panel doesn't soften the modules. */
const TV_QR_PIXELS = 1024;

/**
 * The QR, big enough to scan from the sofa. Same recipe as the board's
 * `QrOverlay` (`qrcode`, maximum contrast, never inverted) but sized for the
 * centre of a television rather than a corner of the bezel.
 *
 * `data-link-url` carries the encoded URL verbatim: a QR is opaque to a test
 * (and to anyone debugging a scan), and the thing that matters about this
 * element is *what it encodes*.
 */
function TvQr({ url, alt }: { readonly url: string; readonly alt: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      margin: 1,
      width: TV_QR_PIXELS,
      errorCorrectionLevel: "M",
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((encoded) => {
        if (!cancelled) setDataUrl(encoded);
      })
      // A screen that can't draw a QR still has the typed code below — degrade
      // to nothing rather than taking the pairing page down with it.
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (dataUrl === null) return null;

  return (
    <img
      src={dataUrl}
      alt={alt}
      className="size-[38vmin] rounded-[1vmin] bg-white p-[1.5vmin]"
      data-testid="tv-qr-image"
      data-link-url={url}
    />
  );
}

export default function TvPairing({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("board");
  const { code, watcher, linkUrl } = loaderData;
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
      data-surface="hardware"
      className="flex h-screen w-screen flex-col items-center justify-center gap-[3vmin] overflow-hidden text-center"
      style={{ backgroundColor: CONSOLE.field, color: CONSOLE.ink }}
      data-testid="tv-pairing"
      data-state={unavailable ? "unavailable" : "waiting"}
    >
      {/*
        The pilot lamp: lit means "waiting for a phone", exactly like the power
        lamp on the real unit. Static on purpose — amber is the console's
        signal colour and a *state*, not an animation (a pulsing lamp is web
        decoration; hardware does not breathe).
      */}
      <p
        className="flex items-center gap-[1.2vmin] text-[2.4vmin] tracking-[0.3em] uppercase"
        style={{ color: CONSOLE.inkMute }}
      >
        <span
          aria-hidden
          className="inline-block size-[1.1vmin]"
          style={{
            backgroundColor: unavailable ? CONSOLE.inkMute : CONSOLE.amber,
          }}
          data-testid="tv-lamp"
        />
        {t("tv.title")}
      </p>

      {unavailable ? (
        <p
          className="max-w-[70vw] text-[3vmin]"
          style={{ color: CONSOLE.inkDim }}
        >
          {t("tv.unavailable")}
        </p>
      ) : (
        <>
          {/*
            The QR on its plate: a hairline-lipped panel screwed to the field,
            the same recipe as the console's plates and the board's own QR
            placard. The white card inside stays pure white — a QR is a machine
            target, not themed UI.
          */}
          {linkUrl !== null && (
            <div
              className="rounded-[0.6vmin] p-[1.6vmin]"
              style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
            >
              <TvQr url={linkUrl} alt={t("tv.qrAlt")} />
            </div>
          )}

          <p
            className="max-w-[70vw] text-[2.6vmin] leading-relaxed"
            style={{ color: CONSOLE.inkDim }}
          >
            {t("tv.instructions")}
          </p>

          {/*
            The fallback as a recessed readout — the digital display on the
            unit, not a headline. Mono with tabular figures, because a code is
            data: fixed advance, nothing shuffles when it rotates.
          */}
          <p
            className="flex items-baseline gap-[2vmin] px-[2.5vmin] py-[1.2vmin] font-mono"
            style={{
              backgroundColor: CONSOLE.track,
              boxShadow:
                "inset 0 1px 0 rgba(0,0,0,0.55), inset 0 0 0 1px rgba(0,0,0,0.4)",
              color: CONSOLE.ink,
            }}
          >
            <span
              className="text-[1.8vmin] uppercase"
              style={{ color: CONSOLE.inkMute, letterSpacing: "0.2em" }}
            >
              {t("tv.codeLabel")}
            </span>
            <span
              className="text-[5.5vmin] leading-none font-bold tracking-[0.25em] tabular-nums"
              data-testid="tv-code"
            >
              {code}
            </span>
          </p>
        </>
      )}
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
