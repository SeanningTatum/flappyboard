import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";

/**
 * The reconnect state, drawn **over** the board rather than instead of it.
 *
 * A split-flap board holding its last message is correct behaviour — that is what
 * the physical object does when you unplug its controller, and a wall of tiles
 * frozen mid-sentence is far better than a blank panel or a spinner where the
 * message used to be. So nothing here replaces `BoardGridView`: it is a
 * low-opacity scrim with a spinner and one line of copy, and the retained grid
 * stays legible underneath it.
 *
 * What it must not do is *pretend* to be live. The corner chip on the display
 * route already says "Reconnecting" for anyone standing close enough to read
 * 1.6vmin type; this is the same fact stated at across-the-room size, so a person
 * who glances up and sees a stale message knows why it is stale.
 *
 * Sized in `vmin` and painted from the neutral scale, same as everything else on
 * `/b/:boardId` — that route is a pure-black kiosk surface with no theme to
 * follow, so the semantic colour variables in `rules/frontend.md` do not apply.
 */

/**
 * The label under the spinner. Spelled out as a map for the same reason
 * `display.tsx` does it: a status with no copy is a type error here rather than a
 * raw `status.whatever` rendered three metres wide.
 */
const STATUS_LABEL_KEYS = {
  connecting: "status.connecting",
  reconnecting: "status.reconnecting",
  offline: "status.offline",
} as const satisfies Record<string, string>;

export type BoardOfflineLabelKey =
  (typeof STATUS_LABEL_KEYS)[keyof typeof STATUS_LABEL_KEYS];

/**
 * `status` is widened to `string` at the prop boundary because it also arrives
 * from `data-status` in tests and from a socket hook that may grow a member. An
 * unrecognised status is treated as "reconnecting": the board is demonstrably not
 * live, and that is the honest, least-alarming way to say so.
 */
export const offlineLabelKey = (status: string): BoardOfflineLabelKey =>
  STATUS_LABEL_KEYS[status as keyof typeof STATUS_LABEL_KEYS] ??
  STATUS_LABEL_KEYS.reconnecting;

export interface BoardOfflineProps {
  /** `useBoardSocket`'s status. `"live"` renders nothing at all. */
  readonly status: string;
  readonly className?: string;
}

export function BoardOffline({ status, className }: BoardOfflineProps) {
  const { t } = useTranslation("board");

  // A healthy board says nothing — same rule as the corner chip.
  if (status === "live") return null;

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-[1.8vmin]",
        // The scrim. Dark enough to read the copy against a bright message,
        // light enough that the grid underneath is plainly still there.
        "bg-black/30",
        className
      )}
      data-testid="board-offline"
      data-status={status}
      role="status"
      aria-live="polite"
    >
      <span
        className="size-[6vmin] animate-spin rounded-full border-[0.55vmin] border-neutral-700 border-t-neutral-300"
        aria-hidden
      />
      <p className="text-[2.2vmin] font-medium tracking-[0.18em] text-neutral-300 uppercase">
        {t(offlineLabelKey(status))}
      </p>
      <p className="text-[1.6vmin] tracking-[0.08em] text-neutral-500">
        {t("status.retained")}
      </p>
    </div>
  );
}
