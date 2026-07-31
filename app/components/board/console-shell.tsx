import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router";
import { IconArrowLeft, IconChevronDown } from "@tabler/icons-react";

import { cn } from "@/lib/utils";
import { authClient } from "@/auth/client";
import { supportedLngs } from "@/i18n";
import { useFetcher } from "react-router";
import {
  CONSOLE,
  PLATE_LIP,
  SegmentTrack,
  segmentClass,
  segmentStyle,
} from "@/components/board/console";

/**
 * The bar across the top of every signed-in console surface — the rack and the
 * controller.
 *
 * There was no such bar before, and the hole it leaves is not cosmetic: **a
 * non-admin user had no way to sign out.** The only sign-out control in the app
 * lived in the admin sidebar's `nav-user`, behind a role gate, so an ordinary
 * household account could reach it exactly never. That is the defect this
 * component exists to close; everything else here is the frame around it.
 *
 * ## Why it is not a `DropdownMenu`
 *
 * Radix would portal the menu to `document.body`. `ConsoleField` now mirrors
 * `data-surface` onto `<html>` precisely so portals inherit the hardware tokens,
 * so a dropdown *would* be correctly themed — but a portal also traps focus,
 * closes on scroll, and positions itself against the viewport, and none of that
 * earns its keep for three links on a phone. A disclosure panel that pushes the
 * page down is one element, works before hydration is finished, and cannot land
 * under a thumb resting at the bottom of the screen.
 *
 * ## Phone ergonomics
 *
 * The bar is the one thing allowed in the top corners, because nothing in it is
 * a primary action: the back link and the account toggle are both recoverable
 * with one more tap, and the actions that matter (send a message, open a board)
 * live in the page below. Every control here is still ≥44px tall.
 */

export interface ConsoleShellProps {
  /**
   * Rendered at the left. Omit on the rack, which is the top of the stack —
   * the wordmark takes the slot instead.
   */
  readonly back?: { readonly to: string; readonly label: string };
  readonly userName: string;
  readonly isAdmin: boolean;
}

/**
 * The wordmark, in the register the bezel's own etching uses: uppercase, widely
 * tracked, no colour. It sits where the back link goes on deeper surfaces, so
 * the top-left of the app is either "where you came from" or "what this is" and
 * never a second copy of the page's own heading.
 */
const WORDMARK = "flappyboard";

/** Shared with the surfaces below so a header and a plate agree on the edge. */
const HEADER_STYLE = {
  backgroundColor: CONSOLE.field,
  boxShadow: `inset 0 -1px 0 ${CONSOLE.hairline}`,
} as const;

const BAR_BUTTON =
  "inline-flex min-h-11 touch-manipulation items-center gap-1.5 text-[11px] font-medium uppercase";

export function ConsoleShell({ back, userName, isAdmin }: ConsoleShellProps) {
  const { t, i18n } = useTranslation("boards");
  const navigate = useNavigate();
  const localeFetcher = useFetcher();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    await authClient.signOut();
    // A full navigation is not needed — the session cookie is already gone and
    // `/login` has no loader that depends on it.
    navigate("/login");
  };

  return (
    <header
      className="sticky top-0 z-20 -mx-4 mb-4 px-4"
      style={HEADER_STYLE}
      data-testid="console-shell"
    >
      <div className="flex items-center justify-between gap-3 py-1.5">
        {back === undefined ? (
          <span
            className="text-[11px] font-medium uppercase"
            style={{ color: CONSOLE.ink, letterSpacing: "0.24em" }}
            data-testid="console-shell-wordmark"
          >
            {WORDMARK}
          </span>
        ) : (
          <Link
            to={back.to}
            className={BAR_BUTTON}
            style={{ color: CONSOLE.inkMute, letterSpacing: "0.16em" }}
            data-testid="console-shell-back"
          >
            <IconArrowLeft className="size-4" aria-hidden />
            {back.label}
          </Link>
        )}

        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          className={cn(BAR_BUTTON, "min-w-11 justify-end")}
          style={{ color: CONSOLE.inkDim, letterSpacing: "0.16em" }}
          data-testid="console-shell-account"
        >
          <span className="max-w-[9rem] truncate normal-case">{userName}</span>
          <IconChevronDown
            aria-hidden
            className={cn("size-4 transition-transform", open && "rotate-180")}
          />
        </button>
      </div>

      {open && (
        <div
          className="mb-3 flex flex-col"
          style={{ backgroundColor: CONSOLE.panel, boxShadow: PLATE_LIP }}
          data-testid="console-shell-menu"
        >
          {/*
            The language control, as two keys rather than a `Select`. The app's
            `LanguageSwitcher` is a Radix select styled for the light surfaces,
            and it submits to the same endpoint this does — what is lost by not
            reusing it is a portal, and what is gained is a control that reads
            as part of the panel it is screwed to.


            `SegmentTrack` + `segmentStyle`, like every other "which one is
            current" control in the product. It used to roll its own — a
            `--hw-track` fill with ink text — which made this the THIRD encoding
            of "selected" on a surface that already had two, and a viewer
            genuinely could not tell whether a lit segment meant "current" or
            "press me". One archetype, one encoding.
          */}
          <div className="p-2">
            <SegmentTrack role="group" aria-label={t("shell.menu")}>
              {supportedLngs.map((lng) => {
                const active = i18n.language === lng;
                return (
                  <button
                    key={lng}
                    type="button"
                    aria-pressed={active}
                    disabled={active || localeFetcher.state !== "idle"}
                    onClick={() =>
                      localeFetcher.submit(
                        { lng },
                        { method: "post", action: "/api/set-locale" }
                      )
                    }
                    className={cn(
                      segmentClass(active),
                      "h-11 flex-1 basis-0 touch-manipulation disabled:opacity-100"
                    )}
                    style={segmentStyle(active)}
                    data-testid={`console-shell-lng-${lng}`}
                  >
                    {lng === "zh" ? "中文" : "EN"}
                  </button>
                );
              })}
            </SegmentTrack>
          </div>

          {isAdmin && (
            <Link
              to="/admin"
              className="flex min-h-11 touch-manipulation items-center px-3 text-[11px] font-medium uppercase"
              style={{
                color: CONSOLE.inkDim,
                letterSpacing: "0.16em",
                boxShadow: `inset 0 1px 0 ${CONSOLE.hairline}`,
              }}
              data-testid="console-shell-admin"
            >
              {t("shell.admin")}
            </Link>
          )}

          <button
            type="button"
            onClick={() => void signOut()}
            disabled={signingOut}
            className="flex min-h-11 touch-manipulation items-center px-3 text-left text-[11px] font-medium uppercase disabled:opacity-40"
            style={{
              color: CONSOLE.inkDim,
              letterSpacing: "0.16em",
              boxShadow: `inset 0 1px 0 ${CONSOLE.hairline}`,
            }}
            data-testid="console-shell-sign-out"
          >
            {signingOut ? t("shell.signingOut") : t("shell.signOut")}
          </button>
        </div>
      )}
    </header>
  );
}
