import { useTranslation } from "react-i18next";
import { IconVolume, IconVolumeOff } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
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

        <label
          className="flex h-12 items-center justify-between gap-3 px-3"
          data-testid="control-mute-row"
        >
          <span
            className="flex items-center gap-2 text-[11px] font-medium uppercase"
            style={{
              color: muted ? CONSOLE.amber : CONSOLE.inkDim,
              letterSpacing: "0.16em",
            }}
          >
            {muted ? (
              <IconVolumeOff className="size-4 shrink-0" aria-hidden />
            ) : (
              <IconVolume className="size-4 shrink-0" aria-hidden />
            )}
            {muted ? t("control.sound.muted") : t("control.sound.unmuted")}
          </span>
          <Switch
            checked={muted}
            disabled={pending}
            onCheckedChange={(next) => onChange({ muted: next })}
            aria-label={t("control.sound.mute_label")}
            data-testid="control-mute"
          />
        </label>
      </div>
    </section>
  );
}
