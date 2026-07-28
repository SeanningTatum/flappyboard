import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { IconPencil } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { effectResolver } from "@/lib/effect-form";
import { MAX_BOARD_NAME } from "@/lib/schemas/board";
import {
  RenameBoardFormSchema,
  type RenameBoardFailure,
  type RenameBoardFormInput,
} from "@/lib/schemas/boards";

/** What the `/boards` action returns for a `rename` submission. */
type RenameBoardActionData =
  | {
      readonly ok: true;
      readonly board: { readonly id: string; readonly name: string };
    }
  | { readonly ok: false; readonly error: RenameBoardFailure };

interface BoardRenameDialogProps {
  readonly boardId: string;
  readonly currentName: string;
}

/**
 * Rename a board from a small dialog, pre-filled with its current name. A
 * fresh `useFetcher` per dialog instance, so one card's rename never shows a
 * pending/error state on another card's button.
 */
export function BoardRenameDialog({
  boardId,
  currentName,
}: BoardRenameDialogProps) {
  const { t } = useTranslation("boards");
  const fetcher = useFetcher<RenameBoardActionData>();
  const [open, setOpen] = useState(false);

  const form = useForm<RenameBoardFormInput>({
    resolver: effectResolver(RenameBoardFormSchema),
    defaultValues: { name: currentName },
  });

  const busy = fetcher.state !== "idle";
  const failure = fetcher.data?.ok === false ? fetcher.data.error : undefined;

  // Re-seed on every open — a previous rename may have changed `currentName`
  // since this dialog last closed, and a stale value would silently revert it.
  useEffect(() => {
    if (open) form.reset({ name: currentName });
  }, [open, currentName, form]);

  // Close only on a successful submission — a failure leaves the dialog open
  // with the error visible, never a silent close.
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

  function onSubmit(values: RenameBoardFormInput) {
    fetcher.submit(
      { intent: "rename", boardId, name: values.name },
      { method: "post" }
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="board-card-rename">
          <IconPencil className="size-4" />
          {t("card.rename")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("rename.title")}</DialogTitle>
          <DialogDescription>{t("rename.description")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <fetcher.Form
            method="post"
            onSubmit={form.handleSubmit(onSubmit)}
            data-testid="board-card-rename-form"
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input
                      type="text"
                      autoComplete="off"
                      maxLength={MAX_BOARD_NAME}
                      data-testid="board-card-rename-input"
                      {...field}
                      disabled={busy}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {failure !== undefined && (
              <div
                role="alert"
                data-testid="board-card-rename-error"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              >
                {failure === "name_too_long"
                  ? t("rename.error.name_too_long", { max: MAX_BOARD_NAME })
                  : failure === "name_empty"
                    ? t("rename.error.name_empty")
                    : t("rename.error.rename_failed")}
              </div>
            )}

            <DialogFooter>
              <Button
                type="submit"
                data-testid="board-card-rename-submit"
                disabled={busy}
              >
                {busy ? t("rename.submitting") : t("rename.submit")}
              </Button>
            </DialogFooter>
          </fetcher.Form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
