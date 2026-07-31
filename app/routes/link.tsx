import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";
import { Form, redirect, useNavigation } from "react-router";
import type { AppLoadContext } from "react-router";

import type { Route } from "./+types/link";
import { requireSession } from "@/lib/session";
import { i18nServer } from "@/i18n/i18n.server";
import {
  normalizeDeviceCode,
  DEVICE_CODE_LENGTH,
} from "@/lib/board/device-code";
import { CONSOLE, ConsoleField, WELL_LIP } from "@/components/board/console";
// The scoped token override for the console surfaces. See the header of that
// file for why this route runs its own visual language.
import "./board/hardware-theme.css";

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
 * ## What this page used to be, and why it is not that any more
 *
 * It was 678 lines: an auto-pair path, a receipt screen, a manual form, an
 * existing-or-new segmented track, a native `<select>` of the account's boards
 * and a naming field. All of it existed to answer one question — *which board
 * should this TV show?* — and the redesign deleted the question:
 *
 * > "I don't even want a new board setup — we should just scan the QR code or
 * > input the code and it adds rather than creating a board and linking it."
 *
 * **A board is a television.** Scanning always makes one. So `resolveAutoLink`,
 * the picker, the `<select>`, the naming field and the receipt are gone, and the
 * happy path renders no UI at all: the loader pairs and redirects straight to
 * the controller. What is left on screen is the fallback for someone who could
 * not scan — a code field — and the named refusals.
 *
 * ## What deliberately did NOT come back
 *
 * There is no "attach this TV to an existing board" control. A TV whose cookie
 * is evicted shows a fresh code, and scanning it makes a *second* board for the
 * same television — real board sprawl, with no stable TV identity to dedupe on.
 * The escape hatch for that is an open question the owner flagged rather than a
 * thing to rebuild the picker for; see the feature doc. Adding it back here
 * would restore the branch this page was rewritten to remove.
 *
 * Approving in the loader is a GET with a side effect, on purpose. `/tv/claim`
 * already redeems a single-use credential exactly this way, the code *is* the
 * authority gate (the scan is the intent), and doing it server-side is what
 * keeps the automatic flow working with JavaScript disabled — the same contract
 * the code form keeps by being a plain `<Form method="post">`.
 *
 * The accepted risk, ratified by the owner (Greptile pre-PR review): ANY
 * authenticated GET carrying a live code pairs — an `<img>` embed or a crafted
 * link, not only a camera scan. It is accepted because a code exists only on the
 * owner's own TV for a few minutes, so knowing one already means being in the
 * room; because the worst outcome is the owner's TV pairing to a board on the
 * owner's own account, deletable from the controller; and because a scan is
 * indistinguishable from any other top-level navigation by design.
 *
 * Dressed as part of the console: this screen is one step in "point phone at
 * TV", sandwiched between the dark TV and the dark controller, and a white web
 * form in the middle is a flashbang aimed at the person holding the phone.
 */

export const handle = { i18n: ["boards"] };

/** Dark console, like the controller it hands off to — see `control.tsx`. */
export const meta: Route.MetaFunction = () => [
  { name: "color-scheme", content: "dark" },
  { name: "theme-color", content: CONSOLE.field },
];

/**
 * The name a board gets when the flow creates it for you. Locale-aware because
 * it prints verbatim on the owner's rack — and a default, never a decision: the
 * controller's Settings tab renames it in one field.
 */
export const defaultBoardName = (locale: string): string =>
  locale.toLowerCase().startsWith("zh") ? "客厅" : "Living Room";

/**
 * Why each refusal is named rather than collapsed to "that didn't work": the
 * owner is holding a phone and looking at a television, and the cases have
 * different next actions — retype it, look again because the TV has rotated, or
 * wait. This is safe to say out loud here (and only here) because the caller is
 * authenticated and the code names nothing of anybody else's; see
 * `DeviceCodeInvalidError`.
 */
export type LinkFailure =
  | "invalid-code"
  | "create_failed"
  | "not-found"
  | "rate-limited"
  | "failed";

/** No code to try, or a code that was refused. Either way: the code field. */
export interface LinkLoaderData {
  /** Prefills the field on a retry, so a mistyped character is one edit away. */
  readonly code: string | null;
  readonly failure: LinkFailure | null;
}

/**
 * Make this television a board and hand it over, as one step.
 *
 * Create-then-approve, with a rollback if approve refuses. The rollback is not
 * defensive tidiness: approve runs *after* create because it needs the board id,
 * so a stale code would otherwise leave an orphaned "Living Room" on the
 * owner's rack every time a TV rotated its code mid-walk. That was caught in
 * verification — one pass with a bogus code left "Bogus Board" behind.
 *
 * If the rollback itself fails, the failure reported is still the approve one,
 * which is the one the owner can act on.
 */
async function pairNewBoard(
  request: Request,
  context: AppLoadContext,
  code: string
): Promise<{ ok: true; boardId: string } | { ok: false; failure: LinkFailure }> {
  const locale = await i18nServer.getLocale(request);

  const created = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.create({ name: defaultBoardName(locale) }),
      catch: (cause) => cause,
    })
  );
  if (Exit.isFailure(created)) return { ok: false, failure: "create_failed" };

  const boardId = created.value.id;

  const approved = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.approveDeviceCode({ boardId, code }),
      catch: (cause) => cause,
    })
  );

  if (Exit.isFailure(approved)) {
    await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => context.trpc.board.delete({ boardId }),
        catch: (cause) => cause,
      })
    );
    return { ok: false, failure: readFailure(approved.cause) };
  }

  return { ok: true, boardId };
}

/** Where a successful pair ends: driving the board the TV just lit up. */
const controllerPath = (boardId: string): string =>
  `/b/${encodeURIComponent(boardId)}/c`;

export async function loader({ request, context }: Route.LoaderArgs) {
  // Anonymous scan → login, then straight back here, code and all.
  await requireSession(request, context);

  const url = new URL(request.url);
  // The QR prefills this; a typed visit gets null and the field stays blank.
  const raw = url.searchParams.get("code");
  const code = normalizeDeviceCode(raw);

  if (code === null) {
    return {
      code: raw,
      // A visit with no code at all is not a failure — it is someone who could
      // not scan. Only a code that was *present and unreadable* is.
      failure: raw === null ? null : "invalid-code",
    } satisfies LinkLoaderData;
  }

  const outcome = await pairNewBoard(request, context, code);
  if (outcome.ok) throw redirect(controllerPath(outcome.boardId));

  return { code: raw, failure: outcome.failure } satisfies LinkLoaderData;
}

export async function action({ request, context }: Route.ActionArgs) {
  // Every action keeps its own gate. A loader gate on this route (or on a
  // layout above it) does NOT protect this POST — React Router runs the leaf
  // action on its own, so removing this line is an auth hole, not a tidy-up.
  await requireSession(request, context);

  const formData = await request.formData();
  const rawCode = formData.get("code");
  const code = normalizeDeviceCode(
    typeof rawCode === "string" ? rawCode : null
  );

  if (code === null) return { failure: "invalid-code" as LinkFailure };

  const outcome = await pairNewBoard(request, context, code);
  if (outcome.ok) throw redirect(controllerPath(outcome.boardId));

  return { failure: outcome.failure };
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
 * Amber focus bezel: a focus indicator is a *signal*, which is amber's one job.
 * An **outline**, not a `ring-*` — the ink keys and wells carry their depth as
 * inline `box-shadow`, and an inline style beats the ring utility's `box-shadow`
 * every time (verification E1: the ring was dead code on the page's primary
 * action). Outline lives on a separate property, so the bezel and the lip
 * compose instead of fighting.
 */
const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[#ffcc00]";

/**
 * The ink key — the console's one action treatment. Off-white plate, dark ink,
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

export default function LinkTv({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { t } = useTranslation("boards");
  const navigation = useNavigation();
  const pending = navigation.state === "submitting";
  const failure = actionData?.failure ?? loaderData.failure;

  return (
    <ConsoleField data-testid="link-root" className="justify-center gap-8">
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

      <Form method="post" className="flex flex-col gap-6">
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
            defaultValue={loaderData.code ?? ""}
            // A code read across a room and typed on a phone: no autocorrect,
            // no capitalisation guessing, and a keyboard that offers letters
            // and digits together.
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            autoFocus
            // Room for the spaces and dashes a phone keyboard adds; the server
            // normalises them away.
            maxLength={DEVICE_CODE_LENGTH * 4}
            placeholder={t("link.codePlaceholder")}
            required
            className={`${WELL_INPUT} font-mono text-lg tracking-[0.4em] uppercase`}
            style={WELL_INPUT_STYLE}
          />
        </div>

        {failure !== null && (
          <p
            className="text-[13px] text-destructive"
            data-testid="link-error"
            role="alert"
          >
            {t(`link.failure.${failure}`)}
          </p>
        )}

        <button
          type="submit"
          disabled={pending}
          data-testid="link-submit"
          className={INK_KEY}
          style={INK_KEY_STYLE}
        >
          {pending ? t("link.submitting") : t("link.submit")}
        </button>
      </Form>
    </ConsoleField>
  );
}
