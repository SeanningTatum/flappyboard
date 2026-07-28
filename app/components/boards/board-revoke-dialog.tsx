import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { IconDeviceMobileOff } from "@tabler/icons-react";

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
import type { RevokeControllersFailure } from "@/lib/schemas/boards";

/** What the `/boards` action returns for a `revoke` submission. */
type RevokeActionData =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RevokeControllersFailure };

interface BoardRevokeDialogProps {
  readonly boardId: string;
  readonly boardName: string;
}

/**
 * "Kick every phone off this board."
 *
 * The only way to take a controller grant back. A grant is a cookie on a phone
 * that may no longer be in the building — it carries no device identity by design,
 * so there is nothing to revoke *individually*; this bumps the board's
 * `grantEpoch` and every outstanding grant for this board stops verifying at once
 * (see `board.revokeControllers`).
 *
 * Confirmed behind an `AlertDialog` naming the board, like delete, for two
 * reasons: it is not undoable (a revoked phone must physically rescan the TV), and
 * it also kills the QR currently on screen until the display's next re-mint tick.
 * Not destructive-styled, though — nothing is lost, and the owner is meant to
 * reach for this freely when a guest goes home.
 *
 * `AlertDialogAction` is Radix's `Dialog.Close`, so `preventDefault()` in the
 * `onClick` keeps the dialog open until the submission actually succeeds — a
 * failure stays visible instead of closing over the top of itself.
 */
export function BoardRevokeDialog({
  boardId,
  boardName,
}: BoardRevokeDialogProps) {
  const { t } = useTranslation("boards");
  const fetcher = useFetcher<RevokeActionData>();
  const [open, setOpen] = useState(false);

  const busy = fetcher.state !== "idle";
  const failure = fetcher.data?.ok === false ? fetcher.data.error : undefined;

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

  function onConfirm() {
    fetcher.submit({ intent: "revoke", boardId }, { method: "post" });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="board-card-revoke">
          <IconDeviceMobileOff className="size-4" />
          {t("card.revoke")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("revoke.title", { name: boardName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("revoke.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {failure !== undefined && (
          <div
            role="alert"
            data-testid="board-card-revoke-error"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t("revoke.error.revoke_failed")}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("revoke.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            data-testid="board-card-revoke-confirm"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? t("revoke.revoking") : t("revoke.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
