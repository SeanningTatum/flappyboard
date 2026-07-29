import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { Form, Link, useNavigation } from "react-router";
import { IconArrowLeft, IconDeviceTv } from "@tabler/icons-react";

import type { Route } from "./+types/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireSession } from "@/lib/session";
import {
  normalizeDeviceCode,
  DEVICE_CODE_LENGTH,
} from "@/lib/board/device-code";

/**
 * `/link` — the owner's half of TV pairing: read the code off the television,
 * type it into the phone already signed in, pick which board the TV should show.
 *
 * This is the only place authority actually crosses. Everything the TV did up to
 * this point was addressing — a code names a room and nothing more — and
 * everything after it is a cookie being banked. The security of the whole flow
 * rests on this page requiring a real session and `approveDeviceCode` refusing
 * any board the caller does not own.
 *
 * Server-action shaped like `/boards`, not a client mutation, for the same
 * reason that page is: the form must work on a phone that has just been handed
 * to somebody, before any JavaScript has settled.
 */

export const handle = { i18n: ["boards"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSession(request, context);

  const listed = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.list(),
      catch: (cause) => cause,
    })
  );

  const boards = Exit.isSuccess(listed)
    ? listed.value.map((board) => ({ id: board.id, name: board.name }))
    : [];

  return { boards };
}

/**
 * Why each refusal is named rather than collapsed to "that didn't work": the
 * owner is holding a phone and looking at a television, and the four cases have
 * four different next actions — retype it, look again because the TV has
 * rotated, press the button on the TV, or wait. This is safe to say out loud
 * here (and only here) because the caller is authenticated and the code names
 * nothing of anybody else's; see `DeviceCodeInvalidError`.
 */
export type LinkFailure =
  | "invalid-code"
  | "no-board"
  | "not-found"
  | "rate-limited"
  | "failed";

export async function action({ request, context }: Route.ActionArgs) {
  await requireSession(request, context);

  const formData = await request.formData();
  const rawCode = formData.get("code");
  const boardId = formData.get("boardId");

  const code = normalizeDeviceCode(
    typeof rawCode === "string" ? rawCode : null
  );
  if (code === null) {
    return { ok: false as const, failure: "invalid-code" as LinkFailure };
  }
  if (typeof boardId !== "string" || boardId === "") {
    return { ok: false as const, failure: "no-board" as LinkFailure };
  }

  const approved = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.approveDeviceCode({ boardId, code }),
      catch: (cause) => cause,
    })
  );

  if (Exit.isFailure(approved)) {
    return { ok: false as const, failure: readFailure(approved.cause) };
  }

  return { ok: true as const, name: approved.value.name };
}

/**
 * Read the tRPC code back off a failed call. Structural rather than typed,
 * because what crosses the server-side caller boundary is a plain error object —
 * and an unrecognised shape must degrade to the generic failure rather than
 * throw inside an error handler.
 */
const readFailure = (cause: unknown): LinkFailure => {
  const code = JSON.stringify(cause ?? "");
  if (code.includes("TOO_MANY_REQUESTS")) return "rate-limited";
  if (code.includes("NOT_FOUND")) return "not-found";
  return "failed";
};

export default function LinkTv({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("boards");
  const { boards } = loaderData;
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";

  if (boards.length === 0) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
        <Empty data-testid="link-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconDeviceTv />
            </EmptyMedia>
            <EmptyTitle>{t("link.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("link.emptyBody")}</EmptyDescription>
          </EmptyHeader>
          <Button asChild size="sm">
            <Link to="/boards">{t("link.emptyAction")}</Link>
          </Button>
        </Empty>
      </div>
    );
  }

  return (
    <div
      data-testid="link-root"
      className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10"
    >
      <Button
        asChild
        variant="ghost"
        size="sm"
        className="-ml-2 w-fit text-muted-foreground"
      >
        <Link to="/boards" data-testid="link-back">
          <IconArrowLeft className="size-4" />
          {t("back")}
        </Link>
      </Button>

      <Card>
        <CardHeader>
          <CardTitle>{t("link.title")}</CardTitle>
          <CardDescription>{t("link.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
              <Label htmlFor="code">{t("link.codeLabel")}</Label>
              <Input
                id="code"
                name="code"
                data-testid="link-code"
                // A code read across a room and typed on a phone: no
                // autocorrect, no capitalisation guessing, and a keyboard that
                // offers letters and digits together.
                autoCapitalize="characters"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                // Room for the spaces and dashes a phone keyboard adds; the
                // server normalises them away.
                maxLength={DEVICE_CODE_LENGTH * 4}
                placeholder={t("link.codePlaceholder")}
                className="font-mono text-lg tracking-[0.4em] uppercase"
                required
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="boardId">{t("link.boardLabel")}</Label>
              {/*
                A native select, deliberately. This form is used once, on a
                phone, by someone who is also looking at a television — the
                platform picker is the fastest thing on that screen and the only
                one guaranteed to work before hydration.
              */}
              <select
                id="boardId"
                name="boardId"
                data-testid="link-board"
                defaultValue={boards[0]?.id}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                required
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>

            {actionData?.ok === true && (
              <p
                className="text-sm text-muted-foreground"
                data-testid="link-success"
                role="status"
              >
                {t("link.success", { name: actionData.name })}
              </p>
            )}

            {actionData?.ok === false && (
              <p
                className="text-sm text-destructive"
                data-testid="link-error"
                role="alert"
              >
                {t(`link.failure.${actionData.failure}`)}
              </p>
            )}

            <Button type="submit" disabled={pending} data-testid="link-submit">
              {pending ? t("link.submitting") : t("link.submit")}
            </Button>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
