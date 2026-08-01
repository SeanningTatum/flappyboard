import { describe, expect, it } from "vitest";

import { authErrorMessage } from "../components/auth-form-parts";
import en from "@/locales/en/auth.json";

/**
 * Better Auth's `message` is an **English server constant**, not translated
 * copy, and both auth forms used to render it verbatim — which put
 * "Invalid email or password" on a fully `zh` page at the one moment a visitor
 * is already stuck. The codes below were read off the live endpoint (401
 * `INVALID_EMAIL_OR_PASSWORD`, 422 `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`),
 * not guessed from the docs.
 */

/** Stands in for `useTranslation("auth").t`, resolving against the real bundle. */
const t = (key: string): string =>
  key.split(".").reduce<unknown>(
    (node, part) =>
      typeof node === "object" && node !== null
        ? (node as Record<string, unknown>)[part]
        : undefined,
    en
  ) as string;

describe("authErrorMessage", () => {
  it("translates the codes it knows", () => {
    expect(
      authErrorMessage(
        { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" },
        t,
        "errors.sign_in_failed"
      )
    ).toBe(en.errors.invalid_credentials);

    expect(
      authErrorMessage(
        {
          code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
          message: "User already exists. Use another email.",
        },
        t,
        "errors.sign_up_failed"
      )
    ).toBe(en.errors.email_taken);
  });

  it("keeps the server's own words for a code it does not know", () => {
    // A ban, a rate limit, anything a future release adds. A specific English
    // sentence is more use to a stuck person than a translated shrug — and
    // mapping an unknown code onto "wrong password" would tell a banned user
    // something false.
    expect(
      authErrorMessage(
        { code: "BANNED_USER", message: "You have been banned from this application" },
        t,
        "errors.sign_in_failed"
      )
    ).toBe("You have been banned from this application");
  });

  it("falls back to our own copy when there is nothing to show", () => {
    expect(authErrorMessage(undefined, t, "errors.sign_in_failed")).toBe(
      en.errors.sign_in_failed
    );
    expect(authErrorMessage({}, t, "errors.sign_up_failed")).toBe(
      en.errors.sign_up_failed
    );
    expect(authErrorMessage({ message: "" }, t, "errors.sign_up_failed")).toBe(
      en.errors.sign_up_failed
    );
  });
});
