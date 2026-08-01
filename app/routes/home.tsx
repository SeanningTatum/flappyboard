import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link, redirect } from "react-router";
import { Effect, Exit } from "effect";
import { useTranslation } from "react-i18next";

import type { Route } from "./+types/home";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { BoardGridView } from "@/components/board/board-grid-view";
import {
  BLANK_GRID,
  BOARD_CAPACITY,
  typedBoard,
} from "@/lib/board/landing-board";
import { tvAddress } from "@/lib/board/tv-address";
import { i18nServer } from "@/i18n/i18n.server";
import { resolveSignedInHome } from "@/lib/session";
import type { BoardGrid } from "@/lib/schemas/board";
import flapFont from "@/assets/fonts/inter-flap-600.woff2?url";

/**
 * `/` — the front door.
 *
 * What this replaced was not a weak landing page, it was **the wrong product's**
 * landing page: `title: "Cloudflare SaaS Starter"`, six feature cards advertising
 * Workers and D1, a Quickstart printing `bun install`, and a section printing
 * `/start-task` and `.brain/recipes/` at end users. A family looking for a
 * message board for their television was being sold a SaaS template.
 *
 * The replacement is one idea, locked and owner-approved in
 * `.brain/features/front-door/front-door.md`: **you drive the board before you
 * sign up.** A live 24 × 6 board with a real text field beside it — the visitor
 * types on the phone they are already holding and the flaps turn, with no
 * account anywhere in the loop. The page *is* a controller, which is the thesis
 * of the product demonstrated instead of claimed. Vestaboard structurally cannot
 * offer this; they cannot let a stranger drive a $3,000 mechanical object from
 * their homepage. Ours are software.
 *
 * Three things here are commitments rather than preferences, and all three have
 * a way of quietly reverting:
 *
 * 1. **No cards.** The deleted page was six `FeatureCard`s plus three
 *    `Card` pillars, and the pull toward "three cards: Type it · Ask the LLM ·
 *    Put it on TV" is enormous. The spec table is what replaced every grid.
 * 2. **The CTA is `--primary` (ink on paper), never amber.** `--signal` is a
 *    pilot lamp; it is spent exactly once on this page, beside the TV address.
 * 3. **No imagery.** The live board is the only media on the page. If the first
 *    viewport still works with the board removed, the board is decoration and
 *    the page has failed.
 */

export const handle = { i18n: ["home"] };

/**
 * The flap face, preloaded — this page renders 144 real tiles, so it is on the
 * board path now even though it is not a board route. It is `font-display:
 * block` (`app.css`), so the alternative to arriving early is 144 tiles painting
 * nothing. `crossOrigin` is required even same-origin: fonts fetch in CORS mode,
 * and a preload without it is a different request than `@font-face` makes.
 */
export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    href: flapFont,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous",
  },
];

/**
 * `<title>` and `<meta>` cannot see `useTranslation` — they render outside the
 * React tree i18next is bound to — so the copy is resolved server-side with
 * `getFixedT` and threaded through the loader. Without this the tab title ships
 * in English to a `zh` visitor.
 */
export const meta: Route.MetaFunction = ({ data }) => [
  { title: data?.title ?? "Flappyboard" },
  { name: "description", content: data?.description ?? "" },
];

/**
 * The index is the only place that answers "where does a signed-in visitor go?"
 * — there is no `/dashboard` to send them to any more. It stays public-only by
 * design: a session means a redirect, so everything below this line is what an
 * anonymous visitor sees and nothing else.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const session = await context.auth.api.getSession({
    headers: request.headers,
  });

  if (session) {
    const listed = await Effect.runPromiseExit(
      Effect.tryPromise({
        try: () => context.trpc.board.list(),
        catch: (cause) => cause,
      })
    );

    // A list failure must not strand a signed-in visitor on the marketing page.
    // The rack is the honest fallback: it re-runs the query and renders its own
    // empty state if it fails again, rather than guessing at a board id here.
    throw redirect(
      Exit.isSuccess(listed) ? resolveSignedInHome(listed.value) : "/boards"
    );
  }

  const t = await i18nServer.getFixedT(request, "home");

  return {
    // Derived from the request, not from configuration — see `tv-address.ts`.
    tv: tvAddress(request.url),
    title: t("meta.title"),
    description: t("meta.description"),
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation("home");
  const { tv } = loaderData;

  const [text, setText] = useState("");
  /*
    The field stays responsive while 144 tiles re-plan behind it: React paints
    the keystroke first and the board catches up on the next idle commit. A
    timer would do the same job with a number nobody can justify.
  */
  const deferred = useDeferredValue(text);
  /*
    Everything the controller reports — the grid, the counter, the hint — is
    computed off the SAME deferred value, so the number under the field always
    describes the board beside it rather than a keystroke the board has not
    taken yet.
  */
  const typed = useMemo(() => typedBoard(deferred), [deferred]);

  /*
    Motion, in full (locked decision 4, extended and approved 2026-07-31): one
    flip on load, then rest, then **user-initiated flips only — never a loop.**

    The load flip falls out of the animator's own contract rather than needing a
    timer. `board-grid-view.tsx:522` treats the first grid it sees as already
    painted ("a page load is still and silent"), so the board is server-rendered
    BLANK and the effect below hands it the opening message one commit later —
    which is a real grid change, and therefore one flip. A blank split-flap is an
    honest state for the object, which is what makes that trade payable.

    Reduced motion needs nothing here: `snapTo` (`board-grid-view.tsx:530`) turns
    the same change into an instant set, and `flap-tile.tsx:339` keeps the
    landing flip a class the animator's inline durations cannot override.
  */
  const [grid, setGrid] = useState<BoardGrid>(BLANK_GRID);

  useEffect(() => {
    // `null` is the CJK case: nothing typed has a flap, so the board holds what
    // it last showed instead of emptying itself, and the hint says why.
    if (typed.grid !== null) setGrid(typed.grid);
  }, [typed]);

  const hint = typed.note === "none" ? "" : t(`say.hint.${typed.note}`);

  return (
    <div className="min-h-svh bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link
            to="/"
            className="text-sm font-semibold tracking-[0.18em] text-text-heading uppercase"
            data-testid="landing-brand"
          >
            {t("brand")}
          </Link>
          {/*
            Utilities, and only utilities, in the top corner — nothing here is on
            the path to using the product. `h-11` / `size-11` because the phone is
            the controller: 44 px is the floor for anything a thumb has to hit.
          */}
          <div className="flex items-center gap-1 [&_button]:size-11">
            <LanguageSwitcher compact className="h-11" />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* `bg-background` is load-bearing, not belt-and-braces: the design audit
          measures body contrast against this element's own computed background,
          and a transparent one reads as black. */}
      <main className="bg-background" data-testid="landing-main">
        <section
          className="flex min-h-[calc(100svh-3.5rem)] flex-col"
          data-testid="landing-controller"
        >
          {/*
            The object, in a dark room, full bleed.

            `className="dark"` is the mechanism the repo already uses for this —
            the tokens inside resolve to their dark values, so the band is
            #121214 with no restated hex anywhere. The board brings its own
            painted-metal mask, which lands a step lighter than the room: canvas →
            plate → flap well is the whole elevation story, no shadows.
          */}
          <div className="dark bg-background px-4 py-4 sm:px-8 sm:py-8">
            {/*
              The field is 2:1 by construction, so its height is half whatever
              width it is given. `min(100%, 78vh)` is the trade: wide enough that
              the object is unmistakably the page on a laptop, short enough that
              the sentence and the text field are in the same viewport as it —
              which is the whole thesis, and the first thing a taller board eats.
            */}
            <div className="mx-auto" style={{ width: "min(100%, 78vh)" }}>
              {/*
                `variant="inline"`, not the default: `BoardFrame` is hard-locked
                to `h-screen w-screen` (`board-frame.tsx:64`) and cannot be
                composed into a page. The inline variant drops the enclosure and
                sizes its glyphs off the container instead of the viewport.
              */}
              <BoardGridView grid={grid} variant="inline" />
            </div>
          </div>

          {/*
            One column on a phone, two from `lg` up — and the split is not
            decoration. Stacked, a laptop puts the text field below the fold, so
            the page claims you can drive the board and then hides the thing you
            drive it with. Side by side, the object, the sentence and the field
            are in one viewport, which is the only arrangement that makes the
            claim true.
          */}
          <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-5 pt-6 pb-8 sm:gap-8 sm:px-8 sm:pt-8 sm:pb-10 lg:flex-row lg:items-start lg:gap-14">
            <div className="flex flex-col gap-4 lg:flex-1">
              <h1 className="max-w-[22ch] text-3xl font-semibold tracking-tight text-balance text-text-heading sm:text-4xl">
                {t("lede.title")}
              </h1>
              <p className="max-w-[52ch] text-base leading-relaxed text-text-body">
                {t("lede.body")}
              </p>
              <p className="max-w-[52ch] text-sm leading-relaxed text-text-body-subtle">
                {t("lede.screensaver")}
              </p>
            </div>

            {/*
              The controller. On a phone `mt-auto` drops the field and the CTA
              into the bottom third of the first screen, where a thumb reaches
              without the hand moving — the owner's standing constraint, which
              outranks how the whitespace looks.
            */}
            <div className="mt-auto flex flex-col gap-4 lg:mt-0 lg:w-[26rem] lg:shrink-0">
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-4">
                  <label
                    htmlFor="landing-say"
                    className="font-mono text-[11px] tracking-[0.16em] text-text-body-subtle uppercase"
                  >
                    {t("say.label")}
                  </label>
                  <span
                    id="landing-say-count"
                    className="font-mono text-[11px] tabular-nums text-text-body-subtle"
                  >
                    {t("say.counter", { used: typed.used, capacity: BOARD_CAPACITY })}
                  </span>
                </div>
                {/*
                  Not a form: there is no submission, no server round trip and
                  nothing to validate — the board *is* the output, live, on every
                  keystroke. So this is a controller rather than a field, and
                  React Hook Form + `effectResolver` would be a resolver with no
                  schema to resolve. Deviation recorded in the run note.

                  `rounded-lg` resolves to `--radius` (2 px): the object is 0 px
                  on panels and buttons, 2 px on wells, and this is a well.
                */}
                <Input
                  id="landing-say"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={t("say.placeholder")}
                  maxLength={200}
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-describedby="landing-say-count landing-say-hint"
                  data-testid="landing-say-input"
                  className="h-12 rounded-lg border-input bg-input/40 px-3 font-mono text-base tracking-[0.08em] uppercase shadow-none"
                />
                <p
                  id="landing-say-hint"
                  aria-live="polite"
                  className="min-h-5 max-w-[60ch] text-xs leading-relaxed text-text-body-subtle"
                  data-testid="landing-say-hint"
                >
                  {hint}
                </p>
              </div>

              <div className="flex flex-col gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:gap-6 sm:pt-5 lg:flex-col lg:items-start lg:gap-2">
                <Button
                  asChild
                  className="h-12 w-full px-6 text-base font-medium sm:w-auto lg:w-full"
                  data-testid="landing-sign-up"
                >
                  <Link to="/sign-up">{t("cta.primary")}</Link>
                </Button>
                <span className="text-sm text-text-body">
                  {t("cta.have_one")}{" "}
                  {/*
                    An inline text link inside a sentence, so WCAG 2.2 SC 2.5.8's
                    inline exception applies — `py-1.5` still buys it a ~32 px
                    tall hit area rather than the 15 px the glyphs occupy.
                  */}
                  <Link
                    to="/login"
                    className="inline-block py-1.5 font-medium text-text-heading underline underline-offset-4"
                    data-testid="landing-sign-in"
                  >
                    {t("cta.sign_in")}
                  </Link>
                </span>
              </div>
            </div>
          </div>
        </section>

        {/*
          The one instruction the product has never given anywhere. Printed
          twice on this page by design — lit here, and again as a spec row —
          because it is the single thing about flappyboard nobody can guess.
        */}
        <section className="border-t border-border" data-testid="landing-tv">
          <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
            <p className="max-w-[58ch] text-base leading-relaxed text-text-body">
              {t("tv.body")}
            </p>
            <div className="mt-8 flex items-start gap-3">
              {/*
                The pilot lamp, and the only place `--signal` is spent on this
                page. It carries no meaning colour alone has to hold: the label
                beside it says what the address is for, and the lamp is hidden
                from the accessibility tree rather than announced as decoration.
              */}
              <span
                aria-hidden
                className="mt-1.5 size-2.5 shrink-0 rounded-lg bg-signal"
              />
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="font-mono text-[11px] tracking-[0.16em] text-text-body-subtle uppercase">
                  {t("tv.label")}
                </span>
                <code
                  className="font-mono text-xl break-all text-text-heading select-all sm:text-3xl"
                  data-testid="landing-tv-address"
                >
                  {tv.display}
                </code>
              </div>
            </div>
          </div>
        </section>

        {/*
          The spec table, borrowed bounded from teenage engineering's EP-133: a
          real table, dense, brand media rather than footer material — and the
          thing that replaced every card grid the old page had.
        */}
        <section className="border-t border-border" data-testid="landing-specs">
          <div className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
            <h2 className="font-mono text-[11px] tracking-[0.2em] text-text-body-subtle uppercase">
              {t("specs.title")}
            </h2>
            <table className="mt-6 w-full border-collapse text-left">
              <caption className="sr-only">{t("specs.caption")}</caption>
              <tbody>
                {SPEC_ROWS.map((key) => (
                  <tr key={key} className="border-t border-border align-top">
                    <th
                      scope="row"
                      className="w-[38%] py-3 pr-4 text-[11px] font-medium tracking-[0.14em] text-text-body-subtle uppercase sm:w-64"
                    >
                      {t(`specs.rows.${key}.label`)}
                    </th>
                    <td className="py-3 font-mono text-[13px] leading-relaxed tabular-nums text-text-body">
                      {key === "address" ? (
                        <span className="break-all select-all">
                          {tv.display}
                        </span>
                      ) : (
                        t(`specs.rows.${key}.value`)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-5xl flex-col gap-2 px-5 py-8 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <span className="text-sm font-semibold tracking-[0.18em] text-text-heading uppercase">
            {t("brand")}
          </span>
          <span className="text-sm text-text-body-subtle">
            {t("footer.note")}
          </span>
        </div>
      </footer>
    </div>
  );
}

/**
 * Every value below is a fact about the object, checked against the code that
 * produces it: 24 × 6 and the 57-glyph charset from `schemas/board.ts`, 72 ms
 * and 4.2 s from `flap-travel.ts`, Chromium 56 from `flap-tile.tsx`'s Tizen
 * constraints. `address` is the one row whose value is not translated copy —
 * it is the visitor's own origin, from the loader.
 */
const SPEC_ROWS = [
  "display",
  "characters",
  "pigments",
  "rate",
  "travel",
  "written",
  "agent",
  "runs",
  "address",
  "pairing",
  "sound",
] as const;
