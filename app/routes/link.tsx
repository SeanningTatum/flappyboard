import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { Form, Link, redirect, useNavigation } from "react-router";
import { IconArrowLeft } from "@tabler/icons-react";

import type { Route } from "./+types/link";
import { loginRedirectUrl } from "@/lib/session";
import { i18nServer } from "@/i18n/i18n.server";
import {
  normalizeDeviceCode,
  DEVICE_CODE_LENGTH,
} from "@/lib/board/device-code";
import {
  isValidBoardName,
  normalizeBoardName,
} from "@/lib/schemas/boards";
import {
  CONSOLE,
  ConsoleField,
  SegmentTrack,
  WELL_LIP,
} from "@/components/board/console";

/**
 * `/link` — the owner's half of TV pairing, and the end of the QR journey:
 * scan the code on the television, sign in if asked, **and the TV is linked.**
 *
 * This is the only place authority actually crosses. Everything the TV did up
 * to this point was addressing — a code names a room and nothing more — and
 * everything after it is a cookie being banked. The security of the whole flow
 * rests on this page requiring a real session and `approveDeviceCode` refusing
 * any board the caller does not own.
 *
 * The QR carries `?code=<CODE>`, and when that code is present the loader
 * resolves the obvious cases itself: a fresh account gets a board created and
 * paired, a one-board account pairs that board — zero typing, no stop. Only a
 * genuinely ambiguous account (several boards) sees the picker, and `?manual=1`
 * forces it. Naming was deliberately dropped from the flow: the board gets a
 * default name and `/boards` already renames.
 *
 * Approving in the loader is a GET with a side effect, on purpose. `/tv/claim`
 * already redeems a single-use credential exactly this way, the code *is* the
 * authority gate (the scan is the intent), and doing it server-side is what
 * keeps the automatic flow working with JavaScript disabled — the same
 * contract the manual form keeps via `:checked` CSS instead of state.
 *
 * Dressed as part of the console, not as an account page: this screen is one
 * step in "point phone at TV", sandwiched between the dark TV and the dark
 * controller, and a white web form in the middle is a flashbang aimed at the
 * person holding the phone.
 */

export const handle = { i18n: ["boards"] };

/** Dark console, like the controller it hands off to — see `control.tsx`. */
export const meta: Route.MetaFunction = () => [
  { name: "color-scheme", content: "dark" },
  { name: "theme-color", content: CONSOLE.field },
];

/**
 * The name a board gets when the flow creates it for you. Locale-aware because
 * it prints verbatim in the owner's dashboard — and a default, never a
 * decision: `/boards` renames in one dialog.
 */
export const defaultBoardName = (locale: string): string =>
  locale.toLowerCase().startsWith("zh") ? "客厅" : "Living Room";

/**
 * Whether the loader can pair without asking. `pick` is the honest answer to
 * ambiguity: with several boards, guessing pairs the wrong TV and the owner
 * has no way to know until the room goes dark.
 */
export type AutoLinkDecision = "create" | "single" | "pick";
export const resolveAutoLink = (boardCount: number): AutoLinkDecision => {
  if (boardCount === 0) return "create";
  if (boardCount === 1) return "single";
  return "pick";
};

/** What the loader renders: the auto-paired panel, or the manual form. */
export type LinkLoaderData =
  | {
      readonly mode: "linked";
      readonly name: string;
      readonly boardId: string;
      /** True when this visit also created the board (fresh account). */
      readonly created: boolean;
      readonly code: string;
    }
  | {
      readonly mode: "form";
      readonly boards: ReadonlyArray<{ readonly id: string; readonly name: string }>;
      readonly code: string | null;
      /** Set when an auto attempt failed and the form should say why. */
      readonly autoError: LinkFailure | null;
    };

export async function loader({ request, context }: Route.LoaderArgs) {
  const session = await context.auth.api.getSession({
    headers: request.headers,
  });
  // Anonymous scan → login, then straight back here, code and all.
  if (!session) throw redirect(loginRedirectUrl(request));

  const url = new URL(request.url);
  // The QR prefills this; a typed visit gets null and the field stays blank.
  const code = normalizeDeviceCode(url.searchParams.get("code"));
  // The escape hatch: "not that board" — render the picker even when the
  // account is unambiguous.
  const manual = url.searchParams.get("manual") === "1";

  const listed = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.list(),
      catch: (cause) => cause,
    })
  );

  const boards = Exit.isSuccess(listed)
    ? listed.value.map((board) => ({ id: board.id, name: board.name }))
    : [];

  const form = (autoError: LinkFailure | null): LinkLoaderData => ({
    mode: "form",
    boards,
    code,
    autoError,
  });

  if (code === null || manual) return form(null);

  const decision = resolveAutoLink(boards.length);
  if (decision === "pick") return form(null);

  let boardId: string;
  let createdBoardId: string | null = null;
  let created = false;

  if (decision === "create") {
    const locale = await i18nServer.getLocale(request);
    const made = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => context.trpc.board.create({ name: defaultBoardName(locale) }),
        catch: (cause) => cause,
      })
    );
    if (Exit.isFailure(made)) return form("create_failed");
    boardId = made.value.id;
    createdBoardId = made.value.id;
    created = true;
  } else {
    boardId = boards[0]!.id;
  }

  const approved = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.approveDeviceCode({ boardId, code }),
      catch: (cause) => cause,
    })
  );

  if (Exit.isFailure(approved)) {
    // Same rollback discipline as the action: never leave an orphan board
    // behind a failed approve (see the comment in `action`).
    if (createdBoardId !== null) {
      const rollbackId = createdBoardId;
      await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => context.trpc.board.delete({ boardId: rollbackId }),
          catch: (cause) => cause,
        })
      );
    }
    // A failed auto attempt is not a dead end — it is the manual form with
    // the reason named (the TV usually rotated its code mid-walk).
    return form(readFailure(approved.cause));
  }

  return {
    mode: "linked",
    name: approved.value.name,
    boardId,
    created,
    code,
  } satisfies LinkLoaderData;
}

/**
 * Why each refusal is named rather than collapsed to "that didn't work": the
 * owner is holding a phone and looking at a television, and the cases have
 * different next actions — retype it, look again because the TV has rotated,
 * wait, or give the new board a usable name. This is safe to say out loud here
 * (and only here) because the caller is authenticated and the code names
 * nothing of anybody else's; see `DeviceCodeInvalidError`.
 */
export type LinkFailure =
  | "invalid-code"
  | "no-board"
  | "no-name"
  | "name_too_long"
  | "create_failed"
  | "not-found"
  | "rate-limited"
  | "failed";

export async function action({ request, context }: Route.ActionArgs) {
  const session = await context.auth.api.getSession({
    headers: request.headers,
  });
  if (!session) throw redirect(loginRedirectUrl(request));

  const formData = await request.formData();
  const rawCode = formData.get("code");

  const code = normalizeDeviceCode(
    typeof rawCode === "string" ? rawCode : null
  );
  if (code === null) {
    return { ok: false as const, failure: "invalid-code" as LinkFailure };
  }

  /*
    Which board the TV should show: an existing one, or one named right here.
    The `new` half is create-then-approve as one submit — the QR flow's promise
    is "scan, sign in, name the board, done", and a second trip to `/boards`
    in the middle of that is exactly the friction this page exists to remove.
  */
  let boardId: string;
  /** Set only on the `new` path — what the rollback below has to delete. */
  let createdBoardId: string | null = null;
  if (formData.get("intent") === "new") {
    const rawName = formData.get("name");
    const name = normalizeBoardName(
      typeof rawName === "string" ? rawName : null
    );
    if (name === undefined) {
      return { ok: false as const, failure: "no-name" as LinkFailure };
    }
    if (!isValidBoardName(name)) {
      return { ok: false as const, failure: "name_too_long" as LinkFailure };
    }

    const created = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => context.trpc.board.create({ name }),
        catch: (cause) => cause,
      })
    );
    if (Exit.isFailure(created)) {
      return { ok: false as const, failure: "create_failed" as LinkFailure };
    }
    boardId = created.value.id;
    createdBoardId = created.value.id;
  } else {
    const picked = formData.get("boardId");
    if (typeof picked !== "string" || picked === "") {
      return { ok: false as const, failure: "no-board" as LinkFailure };
    }
    boardId = picked;
  }

  const approved = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.approveDeviceCode({ boardId, code }),
      catch: (cause) => cause,
    })
  );

  if (Exit.isFailure(approved)) {
    /*
      Roll the create back. Approve runs *after* create (it needs the board id),
      so a bad code would otherwise leave an orphaned, named board behind —
      caught in verification: one E2 pass with a bogus code left "Bogus Board"
      in the owner's list. Delete is owner-scoped and idempotent enough for a
      rollback; if the rollback itself fails the failure reported is still the
      approve one, which is the one the owner can act on.
    */
    if (createdBoardId !== null) {
      // Captured into a const: TypeScript does not carry control-flow
      // narrowing of a reassignable `let` into the closure below.
      const rollbackId = createdBoardId;
      await Effect.runPromiseExit(
        Effect.tryPromise({
          try: () => context.trpc.board.delete({ boardId: rollbackId }),
          catch: (cause) => cause,
        })
      );
    }
    return { ok: false as const, failure: readFailure(approved.cause) };
  }

  return { ok: true as const, name: approved.value.name, boardId };
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

/**
 * Amber focus bezel: a focus indicator is a *signal*, which is amber's one
 * job. An **outline**, not a `ring-*` — the ink keys and wells carry their
 * depth as inline `box-shadow`, and an inline style beats the ring utility's
 * `box-shadow` every time (verification E1: the ring was dead code on the
 * page's primary action). Outline lives on a separate property, so the bezel
 * and the lip compose instead of fighting.
 */
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[#ffcc00]";

/**
 * The ink key — the console's one action treatment (see `segmentStyle`'s
 * active half and the naming prompt's save key). Off-white plate, dark ink,
 * square, with a hardware press at 100ms.
 */
const INK_KEY = `flex h-12 touch-manipulation items-center justify-center text-[11px] font-medium uppercase transition-transform duration-100 active:scale-[0.98] disabled:opacity-40 ${FOCUS_RING}`;
const INK_KEY_STYLE = {
  backgroundColor: CONSOLE.ink,
  color: CONSOLE.panel,
  letterSpacing: "0.14em",
  boxShadow: "inset 0 -1px 0 rgba(0,0,0,0.25)",
} as const;

/** An input cut into the plate: recessed well, 48px of thumb target. */
const WELL_INPUT = `h-12 w-full rounded-[2px] border-0 px-3 text-base shadow-none placeholder:text-[#5a5a5c] ${FOCUS_RING}`;
const WELL_INPUT_STYLE = {
  backgroundColor: CONSOLE.well,
  boxShadow: WELL_LIP,
  color: CONSOLE.ink,
} as const;

/** One segment of the intent track; the checked half raises out of it. */
const SEGMENT = `flex h-11 flex-1 cursor-pointer touch-manipulation items-center justify-center text-[10px] font-medium uppercase select-none has-[:checked]:bg-[#eeeef2] has-[:checked]:text-[#151515] ${FOCUS_RING}`;

export default function LinkTv({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("boards");
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";
  const succeeded = actionData?.ok === true;

  /*
    The end of the automatic journey: the loader already paired the TV, so
    this panel is a *receipt*, not a form — what happened, the way onward
    (the controller), and the one escape (`manual=1`) for "not that board".
  */
  if (loaderData.mode === "linked") {
    const manualUrl = `/link?code=${encodeURIComponent(
      loaderData.code
    )}&manual=1`;
    return (
      <ConsoleField data-testid="link-root" className="gap-8">
        <header className="flex flex-col gap-2 px-1">
          <h1
            className="text-[13px] font-medium uppercase"
            style={{ color: CONSOLE.ink, letterSpacing: "0.18em" }}
          >
            {t("link.title")}
          </h1>
        </header>

        <div
          className="flex flex-col gap-5"
          data-testid="link-auto-success"
          role="status"
        >
          <p
            className="flex items-start gap-2.5 text-[13px] leading-relaxed"
            style={{ color: CONSOLE.inkDim }}
          >
            {/*
              The lamp again: lit amber means "paired", the same signal the
              TV's pilot lamp turns off. One square, no pulse — a state.
            */}
            <span
              aria-hidden
              className="mt-1 size-2 shrink-0"
              style={{ backgroundColor: CONSOLE.amber }}
            />
            {loaderData.created
              ? t("link.auto.created", { name: loaderData.name })
              : t("link.auto.paired", { name: loaderData.name })}
          </p>

          <Link
            to={`/b/${encodeURIComponent(loaderData.boardId)}/c`}
            data-testid="link-open-controller"
            className={INK_KEY}
            style={INK_KEY_STYLE}
          >
            {t("link.openController")}
          </Link>

          <Link
            to={manualUrl}
            data-testid="link-auto-manual"
            className={`inline-flex min-h-11 touch-manipulation items-center justify-center text-[11px] font-medium uppercase ${FOCUS_RING}`}
            style={{ color: CONSOLE.inkMute, letterSpacing: "0.16em" }}
          >
            {t("link.auto.manual")}
          </Link>
        </div>
      </ConsoleField>
    );
  }

  const { boards, code, autoError } = loaderData;
  const shownFailure =
    actionData?.ok === false ? actionData.failure : autoError;

  return (
    <ConsoleField data-testid="link-root" className="gap-8">
      <div>
        <Link
          to="/boards"
          data-testid="link-back"
          className={`inline-flex min-h-11 touch-manipulation items-center gap-2 px-1 text-[11px] font-medium uppercase ${FOCUS_RING}`}
          style={{ color: CONSOLE.inkMute, letterSpacing: "0.16em" }}
        >
          <IconArrowLeft className="size-4" aria-hidden />
          {t("back")}
        </Link>
      </div>

      <header className="flex flex-col gap-2 px-1">
        <h1
          className="text-[13px] font-medium uppercase"
          style={{ color: CONSOLE.ink, letterSpacing: "0.18em" }}
        >
          {t("link.title")}
        </h1>
        <p
          className="text-[13px] leading-relaxed"
          style={{ color: CONSOLE.inkDim }}
        >
          {t("link.subtitle")}
        </p>
      </header>

      {/*
        `group` lets the intent radios drive which field is visible with pure
        `:checked` CSS — no component state, so the no-JS contract covers the
        reveal as well as the submit.
      */}
      <Form method="post" className="group flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label
            htmlFor="code"
            className="px-1 text-[10px] leading-none font-medium uppercase"
            style={{ color: CONSOLE.inkMute, letterSpacing: "0.2em" }}
          >
            {t("link.codeLabel")}
          </label>
          <input
            id="code"
            name="code"
            data-testid="link-code"
            defaultValue={code ?? ""}
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
            required
            className={`${WELL_INPUT} font-mono text-lg tracking-[0.4em] uppercase`}
            style={WELL_INPUT_STYLE}
          />
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend
            className="px-1 pb-1 text-[10px] leading-none font-medium uppercase"
            style={{ color: CONSOLE.inkMute, letterSpacing: "0.2em" }}
          >
            {t("link.boardLabel")}
          </legend>

          {/*
            Existing-or-new as one recessed track with the active option raised
            (see `SegmentTrack`): a pair of web radio buttons is the single
            biggest tell that this is a form, and a track makes "one of these
            is on" legible at a glance. The radios are real, visually hidden
            inside their labels, so the choice submits with no JS at all.
          */}
          <SegmentTrack>
            {boards.length > 0 && (
              <label className={SEGMENT} style={{ color: CONSOLE.inkDim, letterSpacing: "0.14em" }}>
                <input
                  type="radio"
                  name="intent"
                  value="existing"
                  defaultChecked
                  className="sr-only"
                  data-testid="link-intent-existing"
                />
                {t("link.pickExisting")}
              </label>
            )}
            <label className={SEGMENT} style={{ color: CONSOLE.inkDim, letterSpacing: "0.14em" }}>
              <input
                type="radio"
                name="intent"
                value="new"
                defaultChecked={boards.length === 0}
                className="sr-only"
                data-testid="link-intent-new"
              />
              {t("link.pickNew")}
            </label>
          </SegmentTrack>

          {boards.length > 0 && (
            <div className="group-has-[[value=new]:checked]:hidden">
              {/*
                A native select, deliberately — the platform picker is the
                fastest thing on a phone and the only one guaranteed to work
                before hydration. Styled dark explicitly: `color-scheme: dark`
                covers most engines, but not all of them.
              */}
              <select
                name="boardId"
                data-testid="link-board"
                defaultValue={boards[0]?.id}
                className={`${WELL_INPUT} appearance-none`}
                style={WELL_INPUT_STYLE}
              >
                {boards.map((board) => (
                  <option key={board.id} value={board.id}>
                    {board.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div
            className={
              boards.length > 0
                ? "group-has-[[value=existing]:checked]:hidden"
                : undefined
            }
          >
            <input
              name="name"
              data-testid="link-name"
              // A name, not credentials: nothing for a password manager or
              // the autofill heap to offer here.
              autoCapitalize="words"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              inputMode="text"
              placeholder={t("link.newBoardPlaceholder")}
              className={WELL_INPUT}
              style={WELL_INPUT_STYLE}
            />
          </div>
        </fieldset>

        {succeeded && (
          <div
            className="flex flex-col gap-4"
            data-testid="link-success"
            role="status"
          >
            <p
              className="flex items-center gap-2.5 text-[13px]"
              style={{ color: CONSOLE.inkDim }}
            >
              {/*
                The lamp again: lit amber means "paired", the same signal the
                TV's pilot lamp turns off. One square, no pulse — a state.
              */}
              <span
                aria-hidden
                className="size-2 shrink-0"
                style={{ backgroundColor: CONSOLE.amber }}
              />
              {t("link.success", { name: actionData.name })}
            </p>
            {/*
              Pairing ends where using the board begins: the controller for
              the board the TV just flipped to. The owner's session already
              authorises that route — nothing else to redeem.
            */}
            <Link
              to={`/b/${encodeURIComponent(actionData.boardId)}/c`}
              data-testid="link-open-controller"
              className={INK_KEY}
              style={INK_KEY_STYLE}
            >
              {t("link.openController")}
            </Link>
          </div>
        )}

        {shownFailure !== null && (
          <p
            className="text-[13px] text-destructive"
            data-testid="link-error"
            role="alert"
          >
            {t(`link.failure.${shownFailure}`)}
          </p>
        )}

        {!succeeded && (
          <button
            type="submit"
            disabled={pending}
            data-testid="link-submit"
            className={INK_KEY}
            style={INK_KEY_STYLE}
          >
            {pending ? t("link.submitting") : t("link.submit")}
          </button>
        )}
      </Form>
    </ConsoleField>
  );
}
