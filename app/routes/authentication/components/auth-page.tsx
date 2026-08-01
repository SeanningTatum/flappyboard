import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { FlapWord } from "@/components/board/flap-word";
import { DEVICE_CODE_LENGTH } from "@/lib/board/device-code";
import type { AuthRouteData } from "../auth-route";
import { SignInForm } from "./sign-in-form";
import { SignUpForm } from "./sign-up-form";

/**
 * `/login` and `/sign-up` — one surface, two URLs.
 *
 * ## What this replaced
 *
 * A split pane whose own docstring gave the game away: *"an educational context
 * panel on the right (md+ only) so engineers evaluating the boilerplate
 * immediately see what's powering the auth flow."* The right-hand column
 * advertised Better Auth, Drizzle, D1, Workers and Effect TS in pill badges, and
 * the copy promised a visitor they would *"land on a real, role-gated dashboard"*
 * — a page deleted in phase 2. The audience for this product is a family that
 * wants a message board on their television. The landing page shipped this
 * morning; one tap later this was the room behind the front door.
 *
 * ## The three decisions
 *
 * 1. **One page, a segmented toggle, two real URLs.** The toggle is a pair of
 *    `<Link replace>`s, not local state: the URL is the mode, so a refresh, a
 *    bookmark and the back button all mean what they look like, and `/login` /
 *    `/sign-up` stay addressable for `loginRedirectUrl`, the e2e spec and the
 *    design audit's own sign-in step. `replace` because a mode switch is not a
 *    place you should have to press Back out of.
 *
 * 2. **The object, not a column.** What sits above the form is the same
 *    primitive the television is made of — real flaps, in a full-bleed dark room
 *    built the way `/` builds it (`className="dark"`, the mechanism the repo
 *    already uses, so nothing restates a hex). `FlapWord`, not `BoardGridView`:
 *    a short string gets flaps, a board gets a board, and 144 tiles plus an
 *    animator is the wrong weight for a page whose job is a password field.
 *    A changed word is a remount and therefore an instant cut, never a flip —
 *    see `flap-word.tsx`. There is nothing here to gate behind
 *    `prefers-reduced-motion` because nothing travels.
 *
 * 3. **A pairing arrival is a different page.** When `next` carries a device
 *    code the flaps set **that code**, at the size `/tv` sets it, so the six
 *    characters on the television and the six on the phone can be compared at a
 *    glance — the scan confirming itself. The heading and the aside change with
 *    it, and the arrival lands on **sign-up** rather than sign-in, because
 *    somebody who minted a code thirty seconds ago has no account to sign in to.
 *    That choice is made by `loginRedirectUrl` at the gate, not by this page or
 *    by `/login`'s loader: a `/login` that redirected pairing arrivals onward
 *    would make the toggle below a dead control for a returning owner adding a
 *    second television, which is precisely who taps it.
 *
 * ## Standing constraints
 *
 * No card, anywhere — the composition is three full-bleed registers separated by
 * hairlines, the same rhythm as `/`. No drop shadow. The CTA is `--primary`
 * (ink on paper) and never amber; `--signal` is a pilot lamp and does not appear
 * on this page outside the focus ring. Every control clears 44 px and every
 * control boundary is `--text-body-subtle` (6.32:1 on paper, 9.05:1 in dark) —
 * `--input` measures 1.42:1 and fails WCAG 1.4.11, which is the defect
 * `design-critic` found on `/`'s field and on `/link`'s before it.
 */

export type AuthMode = "sign-in" | "sign-up";

interface AuthPageProps extends AuthRouteData {
  readonly mode: AuthMode;
}

/**
 * The mode, as its i18n key. Two spellings for one thing is a smell, and this is
 * the seam that keeps it to one: `sign-in` is the prop (kebab, like every other
 * union in the repo) and `sign_in` is the JSON key (snake, like every other
 * locale key). The template-literal call sites below stay type-checked against
 * the real bundle because this returns a literal union, not `string`.
 */
const modeKey = (mode: AuthMode): "sign_in" | "sign_up" =>
  mode === "sign-in" ? "sign_in" : "sign_up";

export function AuthPage({ mode, next, code, tv }: AuthPageProps) {
  const { t } = useTranslation("auth");
  const { t: tc } = useTranslation("common");

  /*
    `next` rides the toggle. Losing it here would strand a QR-scanning visitor
    at the top of the app after signing in, one tap after they arrived from
    their own television.
  */
  const href = (path: string) =>
    next === null ? path : `${path}?next=${encodeURIComponent(next)}`;

  const pairing = code !== null;

  return (
    /*
      A flex column, not a `min-h-svh` block: the two-column region below has to
      *stretch*, or the hairline dividing form from aside stops wherever the
      taller column's text happens to end and reads as an unfinished stub rather
      than as structure. Elevation here is hairlines, so a hairline that only
      goes halfway is the whole composition going halfway.
    */
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link
            to="/"
            className="text-sm font-semibold tracking-[0.18em] text-text-heading uppercase"
            data-testid="auth-brand"
          >
            {tc("app_name")}
          </Link>
          {/*
            Utilities only in the corner — nothing here is on the path to using
            the product. 44 px is the floor for anything a thumb has to hit.

            `data-[size=default]:h-11` is not belt-and-braces. `SelectTrigger`
            carries `data-[size=default]:h-9`, an attribute-plus-class selector,
            and it beats both a plain `h-11` passed through `cn()` (different
            tailwind-merge group, so the base survives) and the parent's
            `[&_button]:size-11` descendant rule on specificity. Measured before
            the fix: **44 × 36**, not 44 × 44 — the same trap is live on `/`.
          */}
          <div className="flex items-center gap-1 [&_button]:size-11">
            <LanguageSwitcher
              compact
              className="h-11 data-[size=default]:h-11"
            />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* `bg-background` is load-bearing: the design audit measures body
          contrast against this element's own computed background, and a
          transparent one reads as black. */}
      <main className="flex flex-1 flex-col bg-background" data-testid="auth-main">
        {/*
          The object, in a dark room, full bleed — the band that carries over
          from `/`. `border-b` is not trim: forcing the band dark is a no-op when
          the page is already dark, and without a hairline the room that gives
          the object its edge measures 1.00:1 against the canvas and simply
          vanishes (`design-critic` round 1 on the landing page, P1-d).
        */}
        <div className="dark flex justify-center border-b border-border bg-background px-5 py-6 sm:py-8">
          {pairing ? (
            /*
              The code, set the way `/tv` sets it: unlit flaps, white glyphs, no
              pigment. `/tv`'s own note applies unchanged — *"a pigment here
              would be decoration on a string somebody has to read across a
              room"* — and it applies twice as hard here, where the whole job of
              these six characters is to match the six on the screen.
            */
            <FlapWord
              text={code}
              cells={DEVICE_CODE_LENGTH}
              cellWidth="clamp(30px, 9.5vw, 52px)"
              label={t("pairing.flaps_label", { code })}
              data-testid="auth-flaps"
            />
          ) : (
            /*
              A fixed Latin string in both locales, and that is honest rather
              than lazy: `BOARD_CHARS` is Latin by construction, so a translated
              word folds to nothing and would render as a row of blank flaps
              (`foldsToFlaps`). A real split-flap shows Latin flaps to a Chinese
              owner too — the translated sentence lives in the prose beside it.
              Same decision as the landing board.

              Yellow because this is the one lit thing on the page and it is the
              board speaking. `--flap-yellow` is a pigment, theme-invariant and
              unrelated to `--signal`; spending it here spends no signal.
            */
            <FlapWord
              text={t(`${modeKey(mode)}.flaps`)}
              color="yellow"
              cellWidth="clamp(20px, 5.6vw, 40px)"
              label={t(`${modeKey(mode)}.flaps_label`)}
              data-testid="auth-flaps"
            />
          )}
        </div>

        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-5 sm:px-8 lg:grid lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
          <div className="min-w-0 py-8 sm:py-10 lg:pr-14">
            <h1 className="text-2xl font-semibold tracking-tight text-balance text-text-heading sm:text-3xl">
              {pairing ? t("pairing.title") : t(`${modeKey(mode)}.title`)}
            </h1>
            <p className="mt-3 max-w-[46ch] text-base leading-relaxed text-text-body">
              {pairing ? t("pairing.lede") : t(`${modeKey(mode)}.lede`)}
            </p>

            {/*
              The toggle. Links rather than buttons because they navigate, and
              `aria-current="page"` rather than colour alone because a fill is
              never allowed to be the only carrier of state.

              `h-11` inside a `p-0.5` track: 44 px of thumb, and the active
              segment lands at `rounded-md` — which derives to **0 px** at this
              project's 2 px `--radius`. That is the object's own grammar (0 px
              panels, 2 px wells), not a rounding accident.
            */}
            <div
              role="group"
              aria-label={t("mode.legend")}
              className="mt-6 grid grid-cols-2 rounded-lg border border-text-body-subtle p-0.5"
              data-testid="auth-mode"
            >
              <ModeLink
                to={href("/login")}
                active={mode === "sign-in"}
                testId="auth-mode-sign-in"
              >
                {t("mode.sign_in")}
              </ModeLink>
              <ModeLink
                to={href("/sign-up")}
                active={mode === "sign-up"}
                testId="auth-mode-sign-up"
              >
                {t("mode.sign_up")}
              </ModeLink>
            </div>

            <div className="mt-6">
              {mode === "sign-in" ? (
                <SignInForm next={next} />
              ) : (
                <SignUpForm next={next} />
              )}
            </div>
          </div>

          {/*
            Never an empty column. On a pairing arrival this says what the code
            is about to do; otherwise it prints the one instruction the product
            cannot leave out — the TV address — which is also the only thing
            about flappyboard nobody can guess. A ruled column, not a card:
            removing the rule would cost nothing, which is the test a card
            always fails.
          */}
          <aside
            className="min-w-0 border-t border-border py-8 sm:py-10 lg:border-t-0 lg:border-l lg:pl-14"
            data-testid="auth-aside"
          >
            <h2 className="font-mono text-[11px] tracking-[0.2em] text-text-body-subtle uppercase">
              {pairing ? t("pairing.aside_title") : t("tv.label")}
            </h2>
            {pairing ? (
              <>
                <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-body">
                  {t("pairing.aside_body")}
                </p>
                <p className="mt-4 max-w-[52ch] text-sm leading-relaxed text-text-body-subtle">
                  {t("pairing.aside_note")}
                </p>
              </>
            ) : (
              <>
                <code
                  className="mt-4 block font-mono text-xl break-all text-text-heading select-all sm:text-2xl"
                  data-testid="auth-tv-address"
                >
                  {tv.display}
                </code>
                <p className="mt-4 max-w-[52ch] text-base leading-relaxed text-text-body">
                  {t("tv.body")}
                </p>
              </>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}

function ModeLink({
  to,
  active,
  testId,
  children,
}: {
  to: string;
  active: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      // A mode switch, not a destination: Back should leave the auth page, not
      // undo a tap on a segmented control.
      replace
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-11 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-text-body hover:text-text-heading"
      )}
      data-testid={testId}
    >
      {children}
    </Link>
  );
}
