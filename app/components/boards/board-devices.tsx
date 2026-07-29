import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { IconDeviceMobile, IconDeviceTvOff } from "@tabler/icons-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import type { DeviceFailure } from "@/routes/boards/_index";

/**
 * The owner's paired-device list: which phones can drive this board, and one
 * button to un-pair every television showing it.
 *
 * The whole section exists to make one distinction legible, because getting it
 * wrong is the difference between "un-pair the guest who went home" and "make
 * my entire family re-scan a QR code":
 *
 * - **Un-pair, per row** — one phone stops working, nobody else notices.
 * - **Revoke controllers** (on the card above, not here) — every phone at once.
 * - **Un-pair all TVs** — every television, and no phone.
 *
 * They are three different actions against two different revocation counters,
 * so they are given three different placements and three different sentences.
 * A user must never be able to press one thinking it is another.
 */

export interface PairedDevice {
  readonly nonce: string;
  readonly name: string | null;
  readonly lastSeenAt: number;
}

interface BoardDevicesProps {
  readonly boardId: string;
  readonly boardName: string;
  readonly devices: ReadonlyArray<PairedDevice>;
}

type DeviceActionData =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: DeviceFailure };

/**
 * Buckets rather than an exact duration, and deliberately coarse.
 *
 * The question this answers is "is this the phone I think it is?", which
 * "yesterday" settles and "23 hours and 14 minutes" does not. Pure and fed a
 * caller-supplied `now` so it can be tested without a fake clock.
 */
export const lastSeenKey = (
  lastSeenAt: number,
  now: number
): { key: string; count: number } => {
  const elapsed = Math.max(0, now - lastSeenAt);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 2) return { key: "devices.justNow", count: 0 };
  if (minutes < 60) return { key: "devices.minutesAgo", count: minutes };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { key: "devices.hoursAgo", count: hours };
  return { key: "devices.daysAgo", count: Math.floor(hours / 24) };
};

export function BoardDevices({
  boardId,
  boardName,
  devices,
}: BoardDevicesProps) {
  const { t } = useTranslation("boards");

  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-4"
      data-testid="board-devices"
      data-device-count={devices.length}
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{t("devices.title")}</h3>
        <p className="text-xs text-muted-foreground">
          {t("devices.description")}
        </p>
      </div>

      {devices.length === 0 ? (
        <p
          className="text-sm text-muted-foreground"
          data-testid="board-devices-empty"
        >
          {t("devices.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {devices.map((device) => (
            <DeviceRow
              key={device.nonce}
              boardId={boardId}
              device={device}
            />
          ))}
        </ul>
      )}

      <UnpairDisplays boardId={boardId} boardName={boardName} />
    </section>
  );
}

function DeviceRow({
  boardId,
  device,
}: {
  readonly boardId: string;
  readonly device: PairedDevice;
}) {
  const { t } = useTranslation("boards");
  const fetcher = useFetcher<DeviceActionData>();
  const [open, setOpen] = useState(false);

  const busy = fetcher.state !== "idle";
  const failed = fetcher.data?.ok === false;

  // Same close-on-success discipline as `BoardRevokeDialog`: `AlertDialogAction`
  // is Radix's `Dialog.Close`, so the confirm handler prevents the default close
  // and the dialog only goes away once the submission has actually landed.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      if (fetcher.data?.ok === true) setOpen(false);
    }
  }, [busy, fetcher.data]);

  // A device paired before names existed, or one whose owner skipped the field.
  // Named as a state rather than left blank — a blank row reads like a bug.
  const label = device.name ?? t("devices.unnamed");
  const seen = lastSeenKey(device.lastSeenAt, Date.now());

  return (
    <li
      className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
      data-testid="board-device"
    >
      <span className="flex min-w-0 items-center gap-2">
        <IconDeviceMobile className="size-4 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm">{label}</span>
          <span className="text-xs text-muted-foreground">
            {t("devices.lastSeen", {
              when:
                seen.count === 0
                  ? t("devices.justNow")
                  : t(seen.key, { count: seen.count }),
            })}
          </span>
        </span>
      </span>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            data-testid="board-device-unpair"
          >
            {t("devices.unpair")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("devices.unpairOne", { name: label })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("devices.unpairOneBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {failed && (
            <div
              role="alert"
              data-testid="board-device-unpair-error"
              className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {t("devices.error.revoke_device_failed")}
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t("revoke.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              data-testid="board-device-unpair-confirm"
              onClick={(event) => {
                event.preventDefault();
                fetcher.submit(
                  { intent: "revoke-device", boardId, nonce: device.nonce },
                  { method: "post" }
                );
              }}
            >
              {busy ? t("devices.unpairing") : t("devices.unpair")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}

function UnpairDisplays({
  boardId,
  boardName,
}: {
  readonly boardId: string;
  readonly boardName: string;
}) {
  const { t } = useTranslation("boards");
  const fetcher = useFetcher<DeviceActionData>();
  const [open, setOpen] = useState(false);

  const busy = fetcher.state !== "idle";
  const failed = fetcher.data?.ok === false;

  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      if (fetcher.data?.ok === true) setOpen(false);
    }
  }, [busy, fetcher.data]);

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        {/*
          Set apart from the phone rows on purpose. This one is about
          televisions, and the copy says so twice — in the button and again in
          the dialog — because it sits a few pixels away from controls that do
          the opposite thing.
        */}
        <Button
          variant="ghost"
          size="sm"
          className="w-fit text-muted-foreground"
          data-testid="board-devices-unpair-displays"
        >
          <IconDeviceTvOff className="size-4" />
          {t("devices.unpairDisplays")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("devices.unpairDisplaysTitle", { name: boardName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("devices.unpairDisplaysBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {failed && (
          <div
            role="alert"
            data-testid="board-devices-unpair-displays-error"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t("devices.error.revoke_displays_failed")}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("revoke.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            data-testid="board-devices-unpair-displays-confirm"
            onClick={(event) => {
              event.preventDefault();
              fetcher.submit(
                { intent: "revoke-displays", boardId },
                { method: "post" }
              );
            }}
          >
            {busy
              ? t("devices.unpairing")
              : t("devices.unpairDisplaysConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
