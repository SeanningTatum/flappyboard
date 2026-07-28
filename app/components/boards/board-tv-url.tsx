import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCheck, IconCopy } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How long the "Copied" / "Selected" acknowledgement stays on screen. */
const ACK_MS = 2500;

type CopyState = "idle" | "copied" | "manual";

interface BoardTvUrlProps {
  /** The absolute URL a TV browser should be pointed at. */
  readonly url: string;
  readonly className?: string;
}

/**
 * The single most important thing on `/boards`: the address you type into a TV.
 *
 * It is rendered as selectable monospace text **first** and a copy button
 * second, because the copy button is the convenience and the text is the
 * product. Three degradation steps, in order:
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
 */
export function BoardTvUrl({ url, className }: BoardTvUrlProps) {
  const { t } = useTranslation("boards");
  const [state, setState] = useState<CopyState>("idle");
  const urlRef = useRef<HTMLElement>(null);

  // One timer, cleared on unmount and on every state change, so a card that is
  // removed mid-acknowledgement doesn't set state on an unmounted component.
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
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("card.tv_label")}
      </span>
      <div className="flex items-center gap-2">
        <code
          ref={urlRef}
          data-testid="board-card-tv-url"
          // Wraps rather than truncates: this string is the deliverable, so it
          // must be fully readable on a phone as well as copyable.
          className="min-w-0 flex-1 select-all break-all rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-xs text-foreground sm:text-sm"
        >
          {url}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleCopy}
          data-testid="board-card-copy"
          aria-label={t("card.copy")}
          className="shrink-0"
        >
          {state === "copied" ? (
            <IconCheck className="size-4" />
          ) : (
            <IconCopy className="size-4" />
          )}
          <span className="hidden sm:inline">
            {state === "copied" ? t("card.copied") : t("card.copy")}
          </span>
        </Button>
      </div>
      {/* `aria-live` so the acknowledgement reaches a screen reader too. */}
      <span
        aria-live="polite"
        className={cn(
          "text-xs text-muted-foreground transition-opacity",
          state === "manual" ? "opacity-100" : "h-0 overflow-hidden opacity-0"
        )}
      >
        {state === "manual" ? t("card.copy_manual") : ""}
      </span>
    </div>
  );
}
