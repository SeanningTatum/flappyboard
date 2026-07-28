import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { IconTrash } from "@tabler/icons-react";

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
import type { DeleteBoardFailure } from "@/lib/schemas/boards";

/** What the `/boards` action returns for a `delete` submission. */
type DeleteBoardActionData =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: DeleteBoardFailure };

interface BoardDeleteDialogProps {
  readonly boardId: string;
  readonly boardName: string;
}

/**
 * Delete is irreversible and takes the board's whole snapshot history with it
 * (`board_snapshot.boardId` cascades), so this is confirmed behind an
 * `AlertDialog` naming the exact board — a single mis-tap on a list of
 * several boards must not destroy the wrong one.
 *
 * `AlertDialogAction` is Radix's `Dialog.Close` under the hood, so it closes
 * on click by default. The `onClick` below calls `preventDefault()` first —
 * `composeEventHandlers` then skips the close — so the dialog only closes
 * once the delete has actually succeeded; a failure keeps it open with the
 * error visible.
 */
export function BoardDeleteDialog({
  boardId,
  boardName,
}: BoardDeleteDialogProps) {
  const { t } = useTranslation("boards");
  const fetcher = useFetcher<DeleteBoardActionData>();
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
    fetcher.submit({ intent: "delete", boardId }, { method: "post" });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          data-testid="board-card-delete"
        >
          <IconTrash className="size-4" />
          {t("card.delete")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("delete.title", { name: boardName })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("delete.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {failure !== undefined && (
          <div
            role="alert"
            data-testid="board-card-delete-error"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {t("delete.error.delete_failed")}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>
            {t("delete.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            data-testid="board-card-delete-confirm"
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? t("delete.deleting") : t("delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
