import { useTranslation } from "react-i18next";
import { IconVolume } from "@tabler/icons-react";

import { cn } from "@/lib/utils";

/**
 * Browsers refuse to play audio until the user has gestured at the page, and a
 * wall-mounted TV may never be gestured at. So this is an *affordance*, not a
 * gate: it sits in a corner, it never covers the board, and a silent board is a
 * perfectly good board. Once `unlock()` has resolved true it disappears for the
 * rest of the session.
 *
 * Styled as a hardware switch on the bezel rather than a web pill: near-square
 * corners, a hairline bevel, and the same charcoal family as `board-frame.tsx`.
 * Both industrial references we drew on (Elektron, Oxide) hold buttons at 0–1px
 * radius, and a `rounded-full` pill was the loudest remaining "this is a website"
 * tell outside the board itself.
 */

/** Same two-layer bevel as the QR placard, so the corners agree with each other. */
const PLATE_SHADOW =
  "inset 0 0 0 1px rgba(255,255,255,0.075), inset 0 1px 0 rgba(255,255,255,0.05), 0 1px 0 rgba(0,0,0,0.6)";

export interface SoundUnlockPromptProps {
  /** True once the audio context is allowed to play; hides the prompt for good. */
  readonly unlocked: boolean;
  /** Must originate from a real user gesture — this component supplies one. */
  readonly onUnlock: () => void;
  readonly className?: string;
}

export function SoundUnlockPrompt({
  unlocked,
  onUnlock,
  className,
}: SoundUnlockPromptProps) {
  const { t } = useTranslation("board");

  if (unlocked) return null;

  return (
    <button
      type="button"
      onClick={onUnlock}
      className={cn(
        "flex items-center gap-[0.9vmin] rounded-[0.6vmin] px-[1.3vmin] py-[0.9vmin]",
        "text-[1.5vmin] font-medium tracking-[0.14em] uppercase",
        "transition-colors hover:text-neutral-200 focus-visible:outline focus-visible:outline-neutral-400",
        className
      )}
      style={{
        backgroundColor: "#1b1b20",
        boxShadow: PLATE_SHADOW,
        color: "#8e8e95",
      }}
      data-testid="board-sound-unlock"
    >
      <IconVolume className="size-[2.1vmin]" aria-hidden />
      {t("sound.unlock")}
    </button>
  );
}
