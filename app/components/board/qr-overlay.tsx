import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";

import { cn } from "@/lib/utils";

/**
 * "Point your phone at the TV" — the whole pairing UX in one corner.
 *
 * The URL is a **prop**, never derived here. Today the display passes
 * `/b/:boardId/c`, which relies on the phone already being signed in as the
 * board's owner. Phase 4 replaces it with a signed, short-lived pairing token
 * (`/b/:boardId/c?t=<token>`), and that is a change to the *caller* only — this
 * component just encodes whatever string it is handed, so the seam stays clean.
 *
 * Visually it is a **placard screwed to the bezel**, not a floating web card: a
 * dark recessed plate with a hairline bevel, in the same charcoal family as
 * `board-frame.tsx`. Sized so it lives almost entirely inside the bottom bezel
 * rather than covering flaps.
 */

/** Rendered at 2× the on-screen size so a TV panel doesn't soften the modules. */
const QR_PIXELS = 512;

/**
 * The plate. One hairline bevel ring plus one blur-free drop line — the same
 * two-layer recipe as a flap's well, so the enclosure reads as one object.
 */
const PLATE_SHADOW =
  "inset 0 0 0 1px rgba(255,255,255,0.075), inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 0 rgba(0,0,0,0.6)";

export interface QrOverlayProps {
  /** Absolute URL a phone should open. Encoded verbatim. */
  readonly url: string;
  readonly className?: string;
}

export function QrOverlay({ url, className }: QrOverlayProps) {
  const { t } = useTranslation("board");
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      margin: 1,
      width: QR_PIXELS,
      errorCorrectionLevel: "M",
      // A QR code is a machine target, not themed UI: maximum contrast, and
      // never inverted, or half the phone cameras in the room stop reading it.
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((encoded) => {
        if (!cancelled) setDataUrl(encoded);
      })
      // A board that can't draw a QR is still a working board — degrade to the
      // caption rather than taking the screen down with it.
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div
      className={cn(
        "flex items-center gap-[1vmin] rounded-[0.6vmin] p-[0.9vmin]",
        className
      )}
      style={{ backgroundColor: "#1b1b20", boxShadow: PLATE_SHADOW }}
      data-testid="board-qr-overlay"
    >
      {dataUrl !== null && (
        <img
          src={dataUrl}
          alt={t("qr.alt")}
          className="size-[7.4vmin] rounded-[0.2vmin] bg-white"
          data-testid="board-qr-image"
        />
      )}
      <span
        className="max-w-[16vmin] text-[1.5vmin] leading-tight font-medium tracking-[0.14em] uppercase"
        style={{ color: "#8e8e95" }}
      >
        {t("qr.scan")}
      </span>
    </div>
  );
}
