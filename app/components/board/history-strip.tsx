import { useTranslation } from "react-i18next";
import { IconHistory } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/date-utils";
import { Spinner } from "@/components/ui/spinner";
import {
  CONSOLE,
  ConsoleLabel,
  ConsoleReadout,
  PLATE_LIP,
} from "@/components/board/console";
import { gridToMessage } from "@/lib/board/message-io";
import type {
  BoardGrid,
  BoardMessage,
  BoardSource,
} from "@/lib/schemas/board";

/**
 * "Put that one back up." A horizontally scrolling strip of what the board has
 * shown, newest first, one tap to re-flip.
 *
 * Entries are shown as **text**, not as 20 miniature boards: 20 × 144 tiles is
 * ~2,900 DOM nodes on a phone, and the first line of a message is what a person
 * actually recognises it by.
 *
 * So each card is a filing card rather than a screenshot — a punched revision
 * number, the time, and the message in the board's own condensed uppercase. The
 * message text is what makes it recognisable; dressing the card up as a tiny
 * board would promise a fidelity it does not have.
 */

/** Non-empty lines only, for the strip's label. */
const gridToLines = (grid: BoardGrid): ReadonlyArray<string> =>
  grid.rows
    .map((row) =>
      row
        .map((cell) => cell.char)
        .join("")
        .trim()
    )
    .filter((line) => line.length > 0);

export interface HistoryStripEntry {
  readonly id: string;
  readonly revision: number;
  readonly source: BoardSource;
  readonly createdAt: Date;
  /** `null` when the stored snapshot could not be parsed — not replayable. */
  readonly grid: BoardGrid | null;
}

export interface HistoryStripProps {
  readonly entries: ReadonlyArray<HistoryStripEntry>;
  readonly loading: boolean;
  readonly pending: boolean;
  readonly onReplay: (message: BoardMessage) => void;
  readonly className?: string;
}

export function HistoryStrip({
  entries,
  loading,
  pending,
  onReplay,
  className,
}: HistoryStripProps) {
  const { t, i18n } = useTranslation("board");
  const replayable = entries.filter((entry) => entry.grid !== null);

  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <ConsoleLabel>
        <IconHistory className="size-3.5" aria-hidden />
        {t("control.history.title")}
      </ConsoleLabel>

      {loading ? (
        <div
          className="flex h-20 items-center justify-center"
          data-testid="control-history-loading"
        >
          <Spinner className="size-5 text-neutral-600" />
        </div>
      ) : replayable.length === 0 ? (
        <p
          className="px-1 text-[11px]"
          style={{ color: CONSOLE.inkMute }}
          data-testid="control-history-empty"
        >
          {t("control.history.empty")}
        </p>
      ) : (
        // Horizontal scroll with snap: a thumb flick, not a scrollbar. Bled to
        // the screen edges so a half-visible next card is the affordance.
        //
        // `scroll-px-4` is not decoration. `snap-start` aligns to the scrollport
        // edge, so with padding alone the browser silently scrolls 16px on load
        // to satisfy the first card's snap position — and the strip opens with
        // its left card jammed against the bezel. Scroll padding is what
        // snapping actually measures against.
        <ul
          className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto px-4 pb-1 scroll-px-4"
          data-testid="control-history"
        >
          {replayable.map((entry) => {
            const lines = gridToLines(entry.grid!);
            return (
              <li key={entry.id} className="snap-start">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => onReplay(gridToMessage(entry.grid!))}
                  className={cn(
                    "flex h-24 w-40 flex-col items-start gap-1.5 rounded-none p-2 text-left",
                    "active:brightness-125 disabled:opacity-40"
                  )}
                  style={{
                    backgroundColor: CONSOLE.panel,
                    boxShadow: PLATE_LIP,
                  }}
                  data-testid={`control-history-entry-${entry.revision}`}
                  aria-label={t("control.history.replay", {
                    revision: entry.revision,
                  })}
                >
                  <span className="flex w-full items-center justify-between gap-1">
                    <ConsoleReadout value={`#${entry.revision}`} />
                    <span
                      className="font-mono text-[10px]"
                      style={{ color: CONSOLE.inkMute }}
                    >
                      {formatDate(entry.createdAt, "HH:mm", i18n.language)}
                    </span>
                  </span>
                  {/*
                    The message in the board's register: uppercase, tightly
                    tracked, off-white. It is the only part of the card a person
                    actually reads.
                  */}
                  <span
                    className="w-full grow overflow-hidden text-[11px] leading-tight font-medium break-words uppercase"
                    style={{ color: CONSOLE.ink, letterSpacing: "0.04em" }}
                  >
                    {lines.length === 0
                      ? t("control.history.blank")
                      : lines.slice(0, 3).join(" / ")}
                  </span>
                  <span
                    className="text-[9px] font-medium uppercase"
                    style={{ color: CONSOLE.inkMute, letterSpacing: "0.16em" }}
                  >
                    {t(`control.history.source.${entry.source}`)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
