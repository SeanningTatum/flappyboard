import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconCopy } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { CONSOLE, WELL_LIP } from "@/components/board/console";

/** How long the "Copied" / "Selected" acknowledgement stays on screen. */
const ACK_MS = 2500;

type CopyState = "idle" | "copied" | "manual";

interface ConsoleAddressProps {
  /** The absolute URL a TV browser should be pointed at. */
  readonly url: string;
  /** The silkscreen above the well. Defaults to the per-board TV address. */
  readonly label?: string;
  readonly className?: string;
  readonly "data-testid"?: string;
}

/**
 * An address you type into a television, rendered as a recessed readout.
 *
 * The single most important string in the product — nothing else here can be
 * reached without it — so it is selectable monospace text **first** and a copy
 * button second: the button is the convenience, the text is the deliverable.
 * Three degradation steps, in order:
 *
 * 1. `navigator.clipboard.writeText` resolves → "Copied".
 * 2. No Clipboard API (http:// on a phone, older browser, blocked permission) or
 *    the write rejects → select the address in place so ⌘C / Ctrl-C works, and
 *    say so.
 * 3. Selection unavailable too → the address is still plain selectable text with
 *    `user-select: all`, so a long-press or a triple-click gets it by hand.
 *
 * No `try` / `catch`: the clipboard promise is handled with `.then().catch()`,
 * and the selection path is guarded by feature checks rather than by throwing.
 *
 * (Was `boards/board-tv-url.tsx`, dressed as a shadcn card with an outline
 * `Button`. The logic above is unchanged; what moved is the surface — this now
 * lives on the console, where a card and an outline button read as a web form
 * dropped into a piece of hardware.)
 */
export function ConsoleAddress({
  url,
  label,
  className,
  "data-testid": testId = "console-address",
}: ConsoleAddressProps) {
  const { t } = useTranslation("boards");
  const [state, setState] = useState<CopyState>("idle");
  const urlRef = useRef<HTMLElement>(null);

  // One timer, cleared on unmount and on every state change, so a surface that
  // is removed mid-acknowledgement doesn't set state on an unmounted component.
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), ACK_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  /** Fallback: put the address itself in the browser's selection. */
  function selectUrl() {
    const node = urlRef.current;
    const selection = typeof window === "undefined" ? null : window.getSelection();
    if (node !== null && selection !== null) {
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setState("manual");
  }

  function handleCopy() {
    const clipboard =
      typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (typeof clipboard?.writeText !== "function") {
      selectUrl();
      return;
    }
    clipboard
      .writeText(url)
      .then(() => setState("copied"))
      .catch(() => selectUrl());
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <span
        className="text-[10px] leading-none font-medium uppercase"
        style={{ color: CONSOLE.inkMute, letterSpacing: "0.2em" }}
      >
        {label ?? t("card.tv_label")}
      </span>
      <div className="flex items-stretch gap-2">
        <code
          ref={urlRef}
          data-testid={testId}
          // Wraps rather than truncates: this string is the deliverable, so it
          // must be fully readable on a phone as well as copyable.
          className="flex min-w-0 flex-1 items-center rounded-[2px] px-2.5 py-2 font-mono text-[13px] break-all select-all"
          style={{
            backgroundColor: CONSOLE.well,
            boxShadow: WELL_LIP,
            color: CONSOLE.ink,
          }}
        >
          {url}
        </code>
        {/*
          A hairline key, NOT the off-white plate.

          It was the plate, and on the rack that made a copy affordance the
          brightest, highest-contrast object on the page — louder than the three
          boards, which are the page. Copying a URL is a convenience next to the
          text that is the actual deliverable; the plate is reserved for the
          action a surface exists to perform.
        */}
        <button
          type="button"
          onClick={handleCopy}
          data-testid={`${testId}-copy`}
          aria-label={t("card.copy")}
          className="flex min-h-11 min-w-11 shrink-0 touch-manipulation items-center justify-center gap-1.5 px-3.5 text-[11px] font-medium uppercase"
          style={{
            color: CONSOLE.inkDim,
            letterSpacing: "0.14em",
            boxShadow: `inset 0 0 0 1px ${CONSOLE.hairline}`,
          }}
        >
          {state === "copied" ? (
            <IconCheck className="size-4" aria-hidden />
          ) : (
            <IconCopy className="size-4" aria-hidden />
          )}
          <span className="hidden sm:inline">
            {state === "copied" ? t("card.copied") : t("card.copy")}
          </span>
        </button>
      </div>
      {/* `aria-live` so the acknowledgement reaches a screen reader too. */}
      <span
        aria-live="polite"
        className={cn(
          "text-[11px] transition-opacity",
          state === "manual" ? "opacity-100" : "h-0 overflow-hidden opacity-0"
        )}
        style={{ color: CONSOLE.inkMute }}
      >
        {state === "manual" ? t("card.copy_manual") : ""}
      </span>
    </div>
  );
}
