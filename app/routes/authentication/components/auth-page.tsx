import { Link } from "react-router";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { LanguageSwitcher } from "@/components/language-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { BoardBand, FlapPlate } from "@/components/board/board-band";
import { FlapWord } from "@/components/board/flap-word";
import { DEVICE_CODE_LENGTH } from "@/lib/board/device-code";
import { addressFitsFlaps } from "@/lib/board/tv-address";
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
 * wants a message board on their television.
 *
 * ## The one rule this page is built on
 *
 * **The band is a readout. It is present when there is something to read, and
 * absent when there is not.**
 *
 * That rule is the whole answer to `design-critic`'s round-1 verdict, which
 * failed this surface on the slop risk named verbatim in its own lock —
 * *"demoting it to a decorative header strip."* `WELCOME BACK` and `HELLO THERE`
 * were a nameplate carrying zero product information, and they failed the lock's
 * own litmus: delete the band from sign-up and the page loses nothing but its
 * only colour; delete it from a pairing arrival and the page breaks. The critic
 * put the editorial consequence plainly — *"a coffee shop or a boutique hotel
 * could run HELLO THERE in flap yellow over a warm-paper sign-up form
 * unchanged."*
 *
 * So the flaps now only ever set a **string the visitor has to carry to their
 * television**, and there are exactly two:
 *
 * | State | Band | Delete it and… |
 * |---|---|---|
 * | Pairing arrival | the six-character code, live off their own screen | the scan cannot be confirmed |
 * | Sign-up | `host/tv` — the address, from the request | the page no longer says the one thing about this product nobody can guess |
 * | Sign-in | **nothing** | — |
 *
 * Sign-in has no band because a returning owner has nothing to carry anywhere.
 * That is not an omission with a hole where a decoration used to be: the absence
 * is the information, and refusing to spend the primitive is what stops *"the
 * product is present three times and used once"* from being true.
 *
 * The pigment went with it. `--flap-yellow` was being spent on the greeting
 * while the pairing code — live data arriving from the visitor's own television,
 * the emotional peak of the funnel — rendered at 0.00% chroma. Correcting that
 * inversion does not mean painting the code: `/tv` sets it unlit and white, and
 * the whole job of those six characters is to match the six on the screen
 * exactly. It means not spending the pigment on a greeting.
 *
 * ## Composition
 *
 * One centred column. There was a 45/55 two-pane here with a full-height rule
 * down the middle and a right pane that was **87% void** at 1440 — *"the
 * two-pane auth shell you deleted has been structurally reinstated with less in
 * it."* Both columns sat on the same measure, on the same baseline, so it bought
 * neither asymmetry nor scale contrast, only a rule pointing at empty space.
 * The content sets the composition now: header, band, one column, and the
 * register below the form that used to be the aside.
 *
 * ## The mode control, and why there is not one
 *
 * A segmented toggle sat above the form with its active half filled in
 * `--primary`, 470px above a submit button filled in `--primary` — and on
 * sign-up both of them read **"Create account"**. Two visually identical blocks,
 * same fill, same label colour, same 2px radius, the two brightest objects on
 * the dark page and the only two. "Which mode am I in" and "submit this form"
 * cannot be the same visual object.
 *
 * The fix is not a fourth encoding of *selected* — phase 3 fought that exact
 * battle on the console, found three coexisting encodings and settled on one
 * (`SegmentTrack` / `segmentStyle`). It is to notice there is nothing to encode:
 * the mode is the URL, the `<h1>` says it in words, and the other mode is one
 * inline text link — which is the device `/` already ships one tap upstream
 * ("Already have one? *Sign in*"). Fewer parts, no collision, no duplicated
 * label, and the two real URLs, `replace` semantics and `next` propagation the
 * toggle existed for all survive unchanged.
 *
 * ## Standing constraints
 *
 * No card, anywhere. No drop shadow. The CTA is `--primary` (ink on paper) and
 * never amber; `--signal` is a pilot lamp and does not appear on this page
 * outside the focus ring. Every control clears 44px and every control boundary
 * is `--text-body-subtle` (6.32:1 on paper, 9.05:1 in dark) — `--input` measures
 * 1.42:1 and fails WCAG 1.4.11.
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
    `next` rides the link to the other mode. Losing it here would strand a
    QR-scanning visitor at the top of the app after signing in, one tap after
    they arrived from their own television.
  */
  const href = (path: string) =>
    next === null ? path : `${path}?next=${encodeURIComponent(next)}`;

  const pairing = code !== null;
  /*
    Sign-up prints the address; sign-in prints nothing. See the table above —
    this boolean *is* the rule.
  */
  const showAddress = !pairing && mode === "sign-up";
  const band = pairing || showAddress;

  return (
    <div className="flex min-h-svh flex-col bg-background">
      {/*
        The header rule is the band's own top rail whenever there is a band —
        a 1px `--border` hairline stacked directly on a 3px aluminium edge is
        two boundaries doing one boundary's job.
      */}
      <header className={cn(band ? undefined : "border-b border-border")}>
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-5 sm:px-8">
          <Link
            to="/"
            /*
              `inline-flex h-11` is not decoration. Measured at **133 × 20** —
              a 20px-tall target, under WCAG 2.5.8's 24px AA floor let alone the
              44px this project sets for anything a thumb has to hit. The glyphs
              do not move; the box grows around them.
            */
            className="inline-flex h-11 items-center text-sm font-semibold tracking-[0.18em] text-text-heading uppercase"
            data-testid="auth-brand"
          >
            {tc("app_name")}
          </Link>
          {/*
            Utilities only in the corner — nothing here is on the path to using
            the product. Both controls are bare and both are 44×44; the locale
            select used to be a bordered box beside a bare icon at a different
            optical height, which is two treatments for two peers. Fixed inside
            `LanguageSwitcher` so `/` gets it too.
          */}
          <div className="flex items-center gap-1 [&_button]:size-11">
            <LanguageSwitcher compact />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* `bg-background` is load-bearing: the design audit measures body
          contrast against this element's own computed background, and a
          transparent one reads as black. */}
      <main className="flex flex-1 flex-col bg-background" data-testid="auth-main">
        {band ? (
          <BoardBand
            className="flex flex-col items-center gap-3 px-5 py-6 sm:py-8"
            data-testid="auth-band"
          >
            {pairing ? (
              /*
                The code, set the way `/tv` sets it: unlit flaps, white glyphs,
                no pigment. `/tv`'s own note applies unchanged — *"a pigment here
                would be decoration on a string somebody has to read across a
                room"* — and it applies twice as hard here, where the whole job
                of these six characters is to match the six on the screen.
              */
              <FlapPlate>
                <FlapWord
                  text={code}
                  cells={DEVICE_CODE_LENGTH}
                  cellWidth="clamp(30px, 9.5vw, 52px)"
                  label={t("pairing.flaps_label", { code })}
                  data-testid="auth-flaps"
                />
              </FlapPlate>
            ) : (
              <AddressReadout display={tv.display} />
            )}
          </BoardBand>
        ) : null}

        {/*
          One column, centred, `max-w-md` — a measure the form sets rather than
          a 45/55 split committed to before anyone knew what would go in it.
          `justify-center` because with the band above and nothing below, the
          remaining height is the composition: symmetric air reads as intent,
          a rule down the middle of it reads as a missing column.
        */}
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-5 py-10 sm:px-8 sm:py-14">
          <h1 className="text-2xl font-semibold tracking-tight text-balance text-text-heading sm:text-3xl">
            {pairing ? t("pairing.title") : t(`${modeKey(mode)}.title`)}
          </h1>
          <p className="mt-3 text-base leading-relaxed text-text-body">
            {pairing ? t("pairing.lede") : t(`${modeKey(mode)}.lede`)}
          </p>

          <div className="mt-7">
            {mode === "sign-in" ? (
              <SignInForm next={next} />
            ) : (
              <SignUpForm next={next} />
            )}
          </div>

          {/*
            The other mode, as a sentence — `/`'s own device, and deliberately
            *not* labelled with the submit button's words. The test ids are kept
            from the segmented control this replaced: `e2e/auth.spec.ts` drives
            `auth-mode-sign-in` to prove a returning owner adding a second
            television can still get to sign-in from a pairing arrival with
            `next` intact, which is the regression guard for a redirect that once
            made that control dead.
          */}
          <p className="mt-5 text-sm leading-relaxed text-text-body">
            {mode === "sign-in" ? t("alt.no_account") : t("alt.have_account")}{" "}
            {/*
              An inline text link inside a sentence, so WCAG 2.2 SC 2.5.8's
              inline exception applies — `py-1.5` still buys a ~32px tall hit
              area rather than the 15px the glyphs occupy.
            */}
            <Link
              to={mode === "sign-in" ? href("/sign-up") : href("/login")}
              // A mode switch, not a destination: Back should leave the auth
              // page, not undo a tap on a link that swapped two forms.
              replace
              className="inline-block py-1.5 font-medium text-text-heading underline underline-offset-4"
              data-testid={
                mode === "sign-in" ? "auth-mode-sign-up" : "auth-mode-sign-in"
              }
            >
              {mode === "sign-in" ? t("alt.no_account_link") : t("alt.have_account_link")}
            </Link>
          </p>

          {/*
            The register that used to be the right-hand pane. Ruled, not carded:
            removing the rule would cost nothing, which is the test a card always
            fails.

            **Its content is chosen by audience, not by convenience.** It used to
            print the TV address and "scan the code on your screen" on the
            *sign-in* state — acquisition copy aimed at somebody who by
            definition already has an account, sitting in the exact space where
            a password-recovery affordance would live and where a person who has
            just been refused is looking. Now: sign-up gets the instruction,
            pairing gets what the code is about to do, and sign-in gets the truth
            about being locked out.
          */}
          <div
            className="mt-10 border-t border-border pt-6"
            data-testid="auth-note"
          >
            <Eyebrow lamp={pairing}>
              {pairing
                ? t("pairing.aside_title")
                : showAddress
                  ? t("tv.label")
                  : t("locked_out.label")}
            </Eyebrow>
            <p className="mt-4 text-base leading-relaxed text-text-body">
              {pairing
                ? t("pairing.aside_body")
                : showAddress
                  ? t("tv.body")
                  : t("locked_out.body")}
            </p>
            <p className="mt-4 text-sm leading-relaxed text-text-body-subtle">
              {pairing
                ? t("pairing.aside_note")
                : showAddress
                  ? t("tv.note")
                  : t("locked_out.note")}
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

/**
 * The address, as the board would set it, with the exact string printed under it.
 *
 * Two renderings, two jobs, and the second is not redundancy: the drums are
 * upper-case Latin by construction, so the flaps can only ever show
 * `LOCALHOST:5173/TV`. That *is* a working address — hostnames are
 * case-insensitive and React Router matches paths case-insensitively — but a
 * person about to retype it into a television remote should not have to know
 * that, and `role="img"` flaps cannot be selected or copied. So the literal
 * string is printed beneath the readout, the way a barcode prints its own
 * digits.
 *
 * A long host does not overflow, it shrinks — which is its own failure mode. Past
 * `FLAP_ADDRESS_MAX_CHARS` a 42-character preview hostname lands at an 8px tile
 * and becomes texture, so `addressFitsFlaps` drops the flaps and promotes the
 * printed line to display size. Same caller-side contract as `foldsToFlaps`:
 * when a string does not suit the hardware, fall back to type rather than render
 * unreadable tiles.
 */
function AddressReadout({ display }: { readonly display: string }) {
  const { t } = useTranslation("auth");
  const flaps = addressFitsFlaps(display);

  return (
    <>
      {flaps ? (
        <FlapPlate>
          <FlapWord
            text={display}
            /*
              Sized off the character count so the readout always fits its
              container without `overflow-x`, with a ceiling so a short address
              does not become a billboard. 17 characters land at 20px on a 390
              phone and 40px at 1440. The `1rem` allowance is the plate's own
              6px of extrusion plus slack for a scrollbar.
            */
            cellWidth={`min(2.5rem, calc((100vw - 4rem) / ${display.length}))`}
            label={t("tv.flaps_label", { address: display })}
            data-testid="auth-flaps"
          />
        </FlapPlate>
      ) : null}
      <code
        className={cn(
          "block max-w-full font-mono break-all select-all",
          flaps
            ? "text-[11px] tracking-[0.12em] text-text-body-subtle"
            : "text-xl text-text-heading sm:text-2xl"
        )}
        data-testid="auth-tv-address"
      >
        {display}
      </code>
    </>
  );
}

/**
 * A section marker, in the instrument register — and one that survives
 * translation.
 *
 * 11px letterspaced mono caps is the device the whole surface borrows from the
 * EP-133 spec table, and in `zh` it collapsed: CJK has no case to raise, the
 * mono face falls back to a CJK family that carries none of the texture, and
 * 11px is genuinely below the floor for a Han glyph. The result was ordinary
 * small grey caption text — *"the one instrument-grade typographic device below
 * the fold does not survive translation for half the audience."*
 *
 * `:lang(zh)` matches on inherited language, so this reads `<html lang>` with no
 * prop threading. The letterspacing is kept — CSS `letter-spacing` does apply
 * between Han glyphs, and loose-set CJK reads as deliberate rather than as
 * default — and only the size is corrected. Same class of finding, and the same
 * fix in spirit, as the spec table's label column on `/`.
 *
 * ## The lamp
 *
 * `lamp` is the **only** chroma on this surface and it is spent on exactly one
 * state: a pairing arrival. It is not a new device — it is the one `/tv` already
 * draws beside `PAIR THIS SCREEN` (`tv.tsx:262`), a static `--signal` square,
 * `aria-hidden` because the words carry the meaning and colour is never the only
 * carrier.
 *
 * Spending it here rather than on a greeting is the point. `design-critic`
 * measured the inversion: the decorative flap band got the product's yellow
 * while the pairing state — live data arriving off the visitor's own television,
 * the peak of the funnel — rendered at 0.00% chroma. Correcting it does **not**
 * mean painting the code: `/tv` sets those six characters unlit and white and
 * their entire job is to match the six on the screen. It means the greeting
 * loses the pigment and the live state gets the lamp, so that a person standing
 * in front of their television sees the same amber square on both screens.
 *
 * Static, for the reason `/tv` gives: amber is a *state*, and a pulsing lamp is
 * web decoration — hardware does not breathe. Nothing here needs a
 * `prefers-reduced-motion` gate because nothing moves.
 */
function Eyebrow({
  children,
  lamp = false,
}: {
  readonly children: React.ReactNode;
  readonly lamp?: boolean;
}) {
  return (
    <h2 className="flex items-center gap-2 font-mono text-[11px] tracking-[0.2em] text-text-body-subtle uppercase [&:lang(zh)]:text-[13px] [&:lang(zh)]:tracking-[0.14em]">
      {lamp ? (
        <span
          aria-hidden
          className="inline-block size-[6px] shrink-0 bg-signal"
          data-testid="auth-lamp"
        />
      ) : null}
      {children}
    </h2>
  );
}
