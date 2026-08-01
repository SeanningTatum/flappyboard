import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * The three things both auth forms need to agree on, in one place so they cannot
 * drift apart on a surface that shows them one tap from each other.
 */

/**
 * A refusal from the auth server, in the visitor's own language.
 *
 * Better Auth answers with `{ code, message }` and the `message` is **English,
 * always** — it is a server constant, not a translated string. Rendering it
 * verbatim (which both forms used to do) put `"Invalid email or password"` on a
 * fully `zh` page at the one moment a visitor is already stuck. Verified against
 * the live endpoint rather than guessed: a bad password answers 401
 * `INVALID_EMAIL_OR_PASSWORD`, a taken address answers 422
 * `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`.
 *
 * Only codes with a translation are replaced. Anything else — a ban, a rate
 * limit, something added by a future Better Auth release — keeps the server's
 * own words, because a specific English sentence is more use to a stuck person
 * than a translated shrug, and silently mapping an unknown code onto "wrong
 * password" would tell a banned user the wrong thing entirely.
 */
export const authErrorMessage = (
  error: { readonly code?: string; readonly message?: string } | undefined,
  translate: (key: string) => string,
  fallbackKey: string
): string => {
  const known: Record<string, string> = {
    INVALID_EMAIL_OR_PASSWORD: "errors.invalid_credentials",
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "errors.email_taken",
  };
  const key = error?.code === undefined ? undefined : known[error.code];
  if (key !== undefined) return translate(key);
  return error?.message !== undefined && error.message !== ""
    ? error.message
    : translate(fallbackKey);
};

/**
 * Every text field on this surface.
 *
 * **The boundary is `--text-body-subtle`, not `--input`.** `border-input`
 * measures **1.42:1** against warm paper, under WCAG 1.4.11's 3:1 floor for a
 * control boundary — that is the exact defect `design-critic` failed the landing
 * page's field on, and the same defect class as `/link`'s 1.15:1 field in phase
 * 3. `--text-body-subtle` is 6.32:1 on paper and 9.05:1 in dark. The landing
 * page now uses it; this matches.
 *
 * `h-12` is 48 px — the phone is the controller and 44 px is the floor.
 * `rounded-lg` resolves to `--radius` (2 px): the object is 0 px on panels and
 * buttons, 2 px on wells, and a text field is a well. `shadow-none` because
 * elevation here is a hairline and a tonal step, never a blur — the shadcn base
 * ships `shadow-xs`.
 *
 * Note what is *not* here: no `outline-none`. It emits `outline-style: none`,
 * which kills both the app-wide `:focus-visible` outline in `app.css` and its
 * forced-colors fallback. That defect has been fixed twice in this repo
 * (`button.tsx` in phase 1, `input.tsx` and `textarea.tsx` in phase 3).
 */
export const FIELD_CLASS =
  "h-12 rounded-lg border-text-body-subtle bg-input/40 px-3 text-base shadow-none md:text-base";

/**
 * A refused sign-in, said once.
 *
 * Colour is never the only carrier: the icon marks it, the hairline draws it,
 * and the **message itself is `--text-heading`** rather than `--destructive`.
 * That is deliberate — `--destructive` on warm paper is around 4:1 and would be
 * carrying body text at the AA line, so the token marks the box and the ink
 * carries the words.
 */
export function AuthError({
  message,
  testId,
}: {
  readonly message: string | undefined;
  readonly testId: string;
}) {
  if (message === undefined) return null;
  return (
    <div
      role="alert"
      data-testid={testId}
      className="flex items-start gap-3 rounded-lg border border-destructive px-3 py-3"
    >
      <IconAlertTriangle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-destructive"
      />
      <p className="text-sm leading-relaxed text-text-heading">{message}</p>
    </div>
  );
}
