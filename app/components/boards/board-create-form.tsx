import { useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { useFetcher } from "react-router";
import { IconPlus } from "@tabler/icons-react";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { effectResolver } from "@/lib/effect-form";
import { MAX_BOARD_NAME } from "@/lib/schemas/board";
import {
  CreateBoardFormSchema,
  type CreateBoardFailure,
  type CreateBoardFormInput,
} from "@/lib/schemas/boards";
import { cn } from "@/lib/utils";

/** What the `/boards` action returns when it could not create the board. */
type CreateBoardActionData = { readonly ok: false; readonly error: CreateBoardFailure };

interface BoardCreateFormProps {
  /**
   * `"first"` is the empty-state copy ("Create your first board"). Only one
   * instance of this form is ever mounted, so the `data-testid`s stay unique
   * whichever container it renders in.
   */
  readonly variant?: "default" | "first";
  readonly className?: string;
}

export function BoardCreateForm({
  variant = "default",
  className,
}: BoardCreateFormProps) {
  const { t } = useTranslation("boards");
  const fetcher = useFetcher<CreateBoardActionData>();

  const form = useForm<CreateBoardFormInput>({
    resolver: effectResolver(CreateBoardFormSchema),
    defaultValues: { name: "" },
  });

  const busy = fetcher.state !== "idle";
  const failure = fetcher.data?.ok === false ? fetcher.data.error : undefined;

  // A successful create answers with a redirect, so the fetcher lands back at
  // `idle` with no data. That is the signal to clear the field — an error, which
  // *does* carry data, deliberately leaves the typed name in place to edit.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (wasBusy.current) {
      wasBusy.current = false;
      if (fetcher.data === undefined) form.reset({ name: "" });
    }
  }, [busy, fetcher.data, form]);

  function onSubmit(values: CreateBoardFormInput) {
    fetcher.submit({ name: values.name }, { method: "post" });
  }

  return (
    <Form {...form}>
      {/*
        `method="post"` for the same reason the login form carries it: before
        hydration a bare <form> submits as GET, which would put the field in the
        URL and skip the action entirely. POST hits the route action either way,
        so creating a board works on an unhydrated page too.
      */}
      <fetcher.Form
        method="post"
        onSubmit={form.handleSubmit(onSubmit)}
        data-testid="boards-create-form"
        className={cn("flex flex-col gap-4", className)}
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("create.name_label")}</FormLabel>
              <FormControl>
                <Input
                  type="text"
                  autoComplete="off"
                  maxLength={MAX_BOARD_NAME}
                  placeholder={t("create.name_placeholder")}
                  data-testid="boards-create-name"
                  {...field}
                  disabled={busy}
                />
              </FormControl>
              <FormDescription>{t("create.name_hint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {failure !== undefined && (
          <div
            role="alert"
            data-testid="boards-create-error"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {failure === "name_too_long"
              ? t("create.error.name_too_long", { max: MAX_BOARD_NAME })
              : t("create.error.create_failed")}
          </div>
        )}

        <Button
          type="submit"
          data-testid="boards-create-submit"
          disabled={busy}
          className="w-full sm:w-auto sm:self-start"
        >
          <IconPlus className="size-4" />
          {busy
            ? t("create.submitting")
            : variant === "first"
              ? t("create.first_submit")
              : t("create.submit")}
        </Button>
      </fetcher.Form>
    </Form>
  );
}
