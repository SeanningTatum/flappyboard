import { useTranslation } from "react-i18next";
import { IconVolume, IconVolumeOff } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import {
  CONSOLE,
  ConsoleLabel,
  PLATE_LIP,
  SegmentTrack,
  segmentClass,
  segmentStyle,
} from "@/components/board/console";
import { SOUND_PACKS, resolveSoundPack } from "@/lib/board/sfx";

/**
 * Which pack the board clacks with, and whether it clacks at all.
 *
 * Both settings live on the board row and reach the TV through the room's state
 * event, so this component is pure input: it reports a change and re-renders from
 * whatever the parent says the board's settings now are. No local mirror of the
 * value, so a failed write snaps visibly back instead of lying.
 *
 * The pack id is run through `resolveSoundPack` before it is compared, because
 * `board.soundPack` is only a length-bounded string in the schema — an id written
 * by an older deploy must highlight the fallback rather than nothing.
 *
 * Visually this is one plate with two controls and a hairline between them,
 * rather than two floating cards. The mute switch *disables the pack selector*,
 * which is a real dependency between the two controls, and putting them on the
 * same piece of metal is how a panel says so.
 */

export interface SoundPackPickerProps {
  readonly soundPack: string;
  readonly muted: boolean;
  readonly pending: boolean;
  readonly onChange: (settings: { soundPack?: string; muted?: boolean }) => void;
  readonly className?: string;
}

export function SoundPackPicker({
  soundPack,
  muted,
  pending,
  onChange,
  className,
}: SoundPackPickerProps) {
  const { t } = useTranslation("board");
  const activeId = resolveSoundPack(soundPack).id;

  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <ConsoleLabel>{t("control.sound.title")}</ConsoleLabel>

      <div
        className="flex flex-col rounded-none"
        style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
      >
        <div className="p-2">
          {/*
            Muting the board disables the pack selector, so the whole track drops
            to its `off` treatment — see `segmentStyle`. `disabled:opacity-100`
            because the off styling already says "not available"; stacking the
            default 40% dim on top of it just made it unreadable.
          */}
          <SegmentTrack
            role="radiogroup"
            aria-label={t("control.sound.pack_label")}
            data-testid="control-sound-pack"
          >
            {SOUND_PACKS.map((pack) => {
              const active = pack.id === activeId;
              return (
                <button
                  key={pack.id}
                  type="button"
                  // 44px tall: reachable one-handed, and nothing here depends on
                  // hover.
                  className={cn(
                    segmentClass(active),
                    "h-11 flex-1 basis-0",
                    muted && "disabled:opacity-100"
                  )}
                  style={segmentStyle(active, muted)}
                  role="radio"
                  aria-checked={active}
                  disabled={pending || muted}
                  onClick={() => onChange({ soundPack: pack.id })}
                  data-testid={`control-sound-pack-${pack.id}`}
                >
                  {pack.label}
                </button>
              );
            })}
          </SegmentTrack>
        </div>

        {/* A scored line in the plate, not a border around a new box. */}
        <div
          aria-hidden
          className="h-px w-full"
          style={{ backgroundColor: CONSOLE.hairline }}
        />

        {/*
          A two-position rocker, not a switch — and this replaced a shadcn
          `Switch` for two separate reasons, both raised by the design review.

          **It was the only pill and the only circle in the product.** Every
          other control on the console measures 0px radius against a contract
          that says a pill would be a lie, and the white track made it the
          loudest object on the panel — brighter than the amber lamp beside it.

          **And it read backwards.** `checked` meant *muted*, so the affirmative
          state — track lit, knob to the right — meant the board makes no sound.
          A rocker has no affirmative state to get wrong: each half says what it
          does, and the lit half is the one in force.
        */}
        <div className="p-2">
          <SegmentTrack
            role="radiogroup"
            aria-label={t("control.sound.mute_label")}
            data-testid="control-mute"
          >
            {([false, true] as const).map((isMuted) => {
              const active = muted === isMuted;
              const Icon = isMuted ? IconVolumeOff : IconVolume;
              return (
                <button
                  key={String(isMuted)}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={pending}
                  className={cn(
                    segmentClass(active),
                    "h-11 flex-1 basis-0 gap-2 touch-manipulation"
                  )}
                  style={segmentStyle(active)}
                  onClick={() => onChange({ muted: isMuted })}
                  data-testid={`control-mute-${isMuted ? "on" : "off"}`}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  {isMuted
                    ? t("control.sound.muted")
                    : t("control.sound.unmuted")}
                </button>
              );
            })}
          </SegmentTrack>
        </div>
      </div>
    </section>
  );
}
