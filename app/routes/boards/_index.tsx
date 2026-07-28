import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { Link, redirect } from "react-router";
import { IconArrowLeft, IconDeviceTv, IconSparkles } from "@tabler/icons-react";

import type { Route } from "./+types/_index";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { BoardCard } from "@/components/boards/board-card";
import { BoardCreateForm } from "@/components/boards/board-create-form";
import { requireSession } from "@/lib/session";
import {
  isValidBoardName,
  normalizeBoardName,
  type CreateBoardFailure,
  type DeleteBoardFailure,
  type RenameBoardFailure,
  type RevokeControllersFailure,
} from "@/lib/schemas/boards";

/**
 * `/boards` — the owner's board manager: what boards exist, the address to type
 * into a TV, and one form to make another. Everything here is owner-scoped by
 * `board.list` / `board.create` (both `protectedProcedure`), so this route only
 * has to prove there *is* a session.
 *
 * No locale prefix, matching the other app surfaces (`/dashboard`, `/admin`):
 * copy is translated client-side from the `boards` namespace.
 */

export const handle = { i18n: ["boards"] };

/** `?created=<id>` marks the freshly made board so the eye lands on it. */
const CREATED_PARAM = "created";

export async function loader({ request, context }: Route.LoaderArgs) {
  await requireSession(request, context);

  const url = new URL(request.url);
  const boards = await context.trpc.board.list();

  /*
    Paired devices are read here rather than fetched per card on the client.

    One Durable Object round trip per board, in parallel, on a page a household
    opens occasionally — against a client fetch per card, which would render the
    list empty first and fill it in afterwards. A device list that flickers in
    late is worse than one that arrives with the page, because the thing the
    owner came here to do is *compare* what is paired against what should be.

    A board whose room cannot be reached contributes an empty list rather than
    failing the page: the rest of `/boards` still works, and the section says
    "none" instead of taking the board manager down with it.
  */
  const devices = await Promise.all(
    boards.map(async (board) => {
      const listed = await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => context.trpc.board.pairedDevices({ boardId: board.id }),
          catch: (cause) => cause,
        })
      );
      return [
        board.id,
        Exit.isSuccess(listed)
          ? listed.value.map((device) => ({
              nonce: device.nonce,
              name: device.name,
              lastSeenAt: device.lastSeenAt,
            }))
          : [],
      ] as const;
    })
  );
  const devicesByBoard = Object.fromEntries(devices);

  return {
    boards: boards.map((board) => ({
      id: board.id,
      name: board.name,
      revision: board.revision,
      // Serialised over the loader boundary; `BoardCard` re-hydrates it.
      createdAt: board.createdAt,
      devices: devicesByBoard[board.id] ?? [],
    })),
    // The TV needs a host, not a path — taken from the request so it is right on
    // localhost, preview and production without a configured base URL.
    origin: url.origin,
    createdId: url.searchParams.get(CREATED_PARAM),
  };
}

/** What a create attempt returns to `BoardCreateForm`. */
type CreateResult =
  | { readonly ok: false; readonly error: CreateBoardFailure };
/** What a rename attempt returns to `BoardRenameDialog`. */
type RenameResult =
  | {
      readonly ok: true;
      readonly board: { readonly id: string; readonly name: string };
    }
  | { readonly ok: false; readonly error: RenameBoardFailure };
/** What a delete attempt returns to `BoardDeleteDialog`. */
type DeleteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: DeleteBoardFailure };
/** What a revoke attempt returns to `BoardRevokeDialog`. */
type RevokeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RevokeControllersFailure };
/**
 * What the two per-device revokes return to `BoardDevices`. Kept as one shape
 * because the UI treats them identically — a failure is a line of red under the
 * relevant control either way.
 */
export type DeviceFailure = "revoke_device_failed" | "revoke_displays_failed";
type DeviceResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: DeviceFailure };

/**
 * Create a board.
 *
 * `context.trpc.board.create` is a promise that can reject (a `TRPCError` from
 * the procedure, or an infra failure underneath it), so it is lifted with
 * `Effect.tryPromise` and the whole program is run with `runPromiseExit` +
 * `Exit.match` — the HTTP-boundary pattern from `.brain/rules/routes.md`. No
 * `throw`, no `try` / `catch`, and a failed create returns visible copy for the
 * form rather than a blank page or a silent no-op.
 */
async function createBoard(
  formData: FormData,
  context: Route.ActionArgs["context"]
) {
  const rawName = formData.get("name");

  const program = Effect.gen(function* () {
    // Blank → omit `name` entirely and let `board.create` apply its own default.
    const name = normalizeBoardName(typeof rawName === "string" ? rawName : null);
    if (name !== undefined && !isValidBoardName(name)) {
      return { ok: false as const, error: "name_too_long" as CreateBoardFailure };
    }

    const board = yield* Effect.tryPromise({
      try: () => context.trpc.board.create(name === undefined ? {} : { name }),
      catch: (cause) => cause,
    });

    return { ok: true as const, boardId: board.id };
  }).pipe(
    Effect.tapErrorCause((cause) => Effect.logError("board.create_failed", cause)),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        error: "create_failed" as CreateBoardFailure,
      })
    )
  );

  const exit = await context.runtime.runPromiseExit(program);

  return Exit.match(exit, {
    // Redirect back to the list with the new board flagged: the owner sees it in
    // context, with its TV address, which is the next thing they need.
    onSuccess: (result) =>
      result.ok
        ? redirect(`/boards?${CREATED_PARAM}=${encodeURIComponent(result.boardId)}`)
        : (result as CreateResult),
    // A defect (not a typed failure) still has to say something to the form.
    onFailure: () => ({
      ok: false as const,
      error: "create_failed" as CreateBoardFailure,
    }),
  });
}

/**
 * Rename a board. `board.rename` is `protectedProcedure` + `requireOwnedBoard`
 * (see `app/trpc/routes/board.ts`), so a foreign or stale id surfaces as the
 * same generic `rename_failed` here — this route never learns *why* beyond
 * that, which matches the non-enumerable failure shape the procedure layer
 * already commits to.
 */
async function renameBoard(
  formData: FormData,
  context: Route.ActionArgs["context"]
): Promise<RenameResult> {
  const boardId = formData.get("boardId");
  const rawName = formData.get("name");

  const program = Effect.gen(function* () {
    if (typeof boardId !== "string" || boardId.length === 0) {
      return { ok: false as const, error: "rename_failed" as RenameBoardFailure };
    }
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name.length === 0) {
      return { ok: false as const, error: "name_empty" as RenameBoardFailure };
    }
    if (!isValidBoardName(name)) {
      return { ok: false as const, error: "name_too_long" as RenameBoardFailure };
    }

    const board = yield* Effect.tryPromise({
      try: () => context.trpc.board.rename({ boardId, name }),
      catch: (cause) => cause,
    });

    return {
      ok: true as const,
      board: { id: board.id, name: board.name },
    };
  }).pipe(
    Effect.tapErrorCause((cause) => Effect.logError("board.rename_failed", cause)),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        error: "rename_failed" as RenameBoardFailure,
      })
    )
  );

  const exit = await context.runtime.runPromiseExit(program);

  return Exit.match(exit, {
    onSuccess: (result) => result,
    onFailure: () => ({
      ok: false as const,
      error: "rename_failed" as RenameBoardFailure,
    }),
  });
}

/**
 * Delete a board. Irreversible, so the UI only ever calls this from the
 * `AlertDialog`'s confirm action — never on a bare click. `board.delete` is
 * owner-only (`requireOwnedBoard`), matching `renameBoard` above.
 */
async function deleteBoard(
  formData: FormData,
  context: Route.ActionArgs["context"]
): Promise<DeleteResult> {
  const boardId = formData.get("boardId");

  const program = Effect.gen(function* () {
    if (typeof boardId !== "string" || boardId.length === 0) {
      return { ok: false as const, error: "delete_failed" as DeleteBoardFailure };
    }

    yield* Effect.tryPromise({
      try: () => context.trpc.board.delete({ boardId }),
      catch: (cause) => cause,
    });

    return { ok: true as const };
  }).pipe(
    Effect.tapErrorCause((cause) => Effect.logError("board.delete_failed", cause)),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        error: "delete_failed" as DeleteBoardFailure,
      })
    )
  );

  const exit = await context.runtime.runPromiseExit(program);

  return Exit.match(exit, {
    onSuccess: (result) => result,
    onFailure: () => ({
      ok: false as const,
      error: "delete_failed" as DeleteBoardFailure,
    }),
  });
}

/**
 * Revoke every controller grant for a board. Not destructive to any data — it
 * increments the board's `grantEpoch`, which is inside the signed message of every
 * grant it ever issued, so all of them stop verifying at once. Owner-only via
 * `requireOwnedBoard` on `board.revokeControllers`, exactly like delete and
 * rename: a grant must never be able to revoke grants.
 */
async function revokeControllers(
  formData: FormData,
  context: Route.ActionArgs["context"]
): Promise<RevokeResult> {
  const boardId = formData.get("boardId");

  const program = Effect.gen(function* () {
    if (typeof boardId !== "string" || boardId.length === 0) {
      return {
        ok: false as const,
        error: "revoke_failed" as RevokeControllersFailure,
      };
    }

    yield* Effect.tryPromise({
      try: () => context.trpc.board.revokeControllers({ boardId }),
      catch: (cause) => cause,
    });

    return { ok: true as const };
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("board.revoke_failed", cause)
    ),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        error: "revoke_failed" as RevokeControllersFailure,
      })
    )
  );

  const exit = await context.runtime.runPromiseExit(program);

  return Exit.match(exit, {
    onSuccess: (result) => result,
    onFailure: () => ({
      ok: false as const,
      error: "revoke_failed" as RevokeControllersFailure,
    }),
  });
}

/**
 * Un-pair one phone, by the nonce inside its grant.
 *
 * The precision instrument next to `revokeControllers`' hammer: the board's
 * `grantEpoch` does not move, so every other phone in the house keeps working
 * and nobody re-scans. That is only possible because the room keeps a per-grant
 * record — see `board.revokeDevice`.
 */
async function revokeDevice(
  formData: FormData,
  context: Route.ActionArgs["context"]
): Promise<DeviceResult> {
  const boardId = formData.get("boardId");
  const nonce = formData.get("nonce");

  const program = Effect.gen(function* () {
    if (
      typeof boardId !== "string" ||
      boardId.length === 0 ||
      typeof nonce !== "string" ||
      nonce.length === 0
    ) {
      return {
        ok: false as const,
        error: "revoke_device_failed" as DeviceFailure,
      };
    }

    yield* Effect.tryPromise({
      try: () => context.trpc.board.revokeDevice({ boardId, nonce }),
      catch: (cause) => cause,
    });

    return { ok: true as const };
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("board.revoke_device_failed", cause)
    ),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        error: "revoke_device_failed" as DeviceFailure,
      })
    )
  );

  const exit = await context.runtime.runPromiseExit(program);
  return Exit.match(exit, {
    onSuccess: (result) => result,
    onFailure: () => ({
      ok: false as const,
      error: "revoke_device_failed" as DeviceFailure,
    }),
  });
}

/**
 * Un-pair every TV showing this board, and no phone at all.
 *
 * Bumps `deviceEpoch`, the board row's second revocation counter. The whole
 * reason there are two is that these must not be the same button: revoking the
 * family's controllers should never black out the television, and un-pairing
 * the television should never sign out the family.
 */
async function revokeDisplays(
  formData: FormData,
  context: Route.ActionArgs["context"]
): Promise<DeviceResult> {
  const boardId = formData.get("boardId");

  const program = Effect.gen(function* () {
    if (typeof boardId !== "string" || boardId.length === 0) {
      return {
        ok: false as const,
        error: "revoke_displays_failed" as DeviceFailure,
      };
    }

    yield* Effect.tryPromise({
      try: () => context.trpc.board.revokeDevices({ boardId }),
      catch: (cause) => cause,
    });

    return { ok: true as const };
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("board.revoke_displays_failed", cause)
    ),
    Effect.catchAll(() =>
      Effect.succeed({
        ok: false as const,
        error: "revoke_displays_failed" as DeviceFailure,
      })
    )
  );

  const exit = await context.runtime.runPromiseExit(program);
  return Exit.match(exit, {
    onSuccess: (result) => result,
    onFailure: () => ({
      ok: false as const,
      error: "revoke_displays_failed" as DeviceFailure,
    }),
  });
}

/**
 * One action for the whole `/boards` surface, dispatched by an `intent`
 * field. `create` has none (the existing `BoardCreateForm` predates this and
 * is left untouched), so a missing/unrecognised intent falls through to it —
 * every existing create submission keeps working unchanged.
 */
export async function action({ request, context }: Route.ActionArgs) {
  await requireSession(request, context);

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "rename") return renameBoard(formData, context);
  if (intent === "delete") return deleteBoard(formData, context);
  if (intent === "revoke") return revokeControllers(formData, context);
  if (intent === "revoke-device") return revokeDevice(formData, context);
  if (intent === "revoke-displays") return revokeDisplays(formData, context);
  return createBoard(formData, context);
}

export default function BoardsIndex({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("boards");
  const { boards, origin, createdId } = loaderData;
  const isEmpty = boards.length === 0;

  return (
    <div
      data-testid="boards-root"
      className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10 lg:px-6"
    >
      <header className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
            <Link to="/dashboard" data-testid="boards-back">
              <IconArrowLeft className="size-4" />
              {t("back")}
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <LanguageSwitcher compact />
            <ThemeToggle />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <IconSparkles className="size-3" />
            {t("eyebrow")}
          </span>
          <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="max-w-xl text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      </header>

      {isEmpty ? (
        /*
          Zero boards is the first thing a new account sees, so the empty state
          teaches the product in one line and then offers the only action worth
          offering. The create form is *inside* it — the same single instance
          that lives in the card below once boards exist, so there is never a
          duplicate form (or a duplicate `data-testid`) on the page.
        */
        <Empty data-testid="boards-empty" className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <IconDeviceTv />
            </EmptyMedia>
            <EmptyTitle>{t("empty.title")}</EmptyTitle>
            <EmptyDescription>{t("empty.body")}</EmptyDescription>
          </EmptyHeader>
          <div className="w-full max-w-sm text-left">
            <BoardCreateForm variant="first" />
          </div>
        </Empty>
      ) : (
        <>
          <Card>
            <CardHeader className="gap-1">
              <CardTitle className="text-base">{t("create.title")}</CardTitle>
              <CardDescription>{t("create.description")}</CardDescription>
            </CardHeader>
            <CardContent>
              <BoardCreateForm />
            </CardContent>
          </Card>

          <section className="flex flex-col gap-4">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              {t("list.title")}
            </h2>
            <div className="flex flex-col gap-4">
              {boards.map((board) => (
                <BoardCard
                  key={board.id}
                  board={board}
                  origin={origin}
                  isNew={board.id === createdId}
                />
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
