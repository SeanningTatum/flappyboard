import { describe, expect, it } from "vitest";

import en from "@/locales/en/auth.json";
import zh from "@/locales/zh/auth.json";
import { normalizeText } from "@/lib/board/compile";
import { BOARD_COLS } from "@/lib/schemas/board";

/**
 * **Locale-key parity for the auth surface.** Renders nothing — it asserts that
 * every key `auth-page.tsx` and the two forms ask `t()` for exists in *both*
 * bundles, that neither bundle drifts, and that the copy this rewrite deleted
 * cannot come back.
 *
 * Worth a test rather than a review for three reasons, all of which this file
 * has already had to catch once somewhere in the repo: a missing key renders the
 * raw dotted path as a heading and is not a type error; a `zh` bundle that
 * quietly keeps an English sentence is not a type error either; and the flap
 * strings have a hard constraint no reviewer will remember — they must survive
 * the fold onto `BOARD_CHARS`, which is Latin by construction, so a translator
 * "helpfully" localising them would render a row of blank flaps.
 */

const lookup = (bundle: unknown, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[part]
          : undefined,
      bundle
    );

/** Every leaf path in a bundle, dotted. */
const paths = (node: unknown, prefix = ""): ReadonlyArray<string> => {
  if (typeof node !== "object" || node === null) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
    paths(value, prefix === "" ? key : `${prefix}.${key}`)
  );
};

/** Every key the surface renders, with the interpolations it passes. */
const KEYS: ReadonlyArray<{ key: string; vars?: ReadonlyArray<string> }> = [
  { key: "meta.sign_in_title" },
  { key: "meta.sign_up_title" },
  { key: "meta.description" },
  { key: "mode.legend" },
  { key: "mode.sign_in" },
  { key: "mode.sign_up" },
  { key: "sign_in.flaps" },
  { key: "sign_in.flaps_label" },
  { key: "sign_in.title" },
  { key: "sign_in.lede" },
  { key: "sign_in.email_label" },
  { key: "sign_in.email_placeholder" },
  { key: "sign_in.password_label" },
  { key: "sign_in.submit" },
  { key: "sign_in.submitting" },
  { key: "sign_up.flaps" },
  { key: "sign_up.flaps_label" },
  { key: "sign_up.title" },
  { key: "sign_up.lede" },
  { key: "sign_up.name_label" },
  { key: "sign_up.name_placeholder" },
  { key: "sign_up.email_label" },
  { key: "sign_up.email_placeholder" },
  { key: "sign_up.password_label" },
  { key: "sign_up.password_hint" },
  { key: "sign_up.confirm_password_label" },
  { key: "sign_up.submit" },
  { key: "sign_up.submitting" },
  { key: "pairing.flaps_label", vars: ["code"] },
  { key: "pairing.title" },
  { key: "pairing.lede" },
  { key: "pairing.aside_title" },
  { key: "pairing.aside_body" },
  { key: "pairing.aside_note" },
  { key: "tv.label" },
  { key: "tv.body" },
  // Resolved through `authErrorMessage`, which maps Better Auth's English
  // server constants onto these before anything reaches the alert.
  { key: "errors.invalid_credentials" },
  { key: "errors.email_taken" },
  { key: "errors.sign_in_failed" },
  { key: "errors.sign_up_failed" },
];

const BUNDLES: ReadonlyArray<readonly [string, unknown]> = [
  ["en", en],
  ["zh", zh],
];

/** The two strings that are set in real flaps rather than typeset. */
const FLAP_KEYS = ["sign_in.flaps", "sign_up.flaps"] as const;

describe("the auth surface's copy", () => {
  for (const [name, bundle] of BUNDLES) {
    it(`resolves every key the surface renders — ${name}`, () => {
      for (const { key } of KEYS) {
        const value = lookup(bundle, key);
        expect(typeof value, `${name}: ${key}`).toBe("string");
        expect((value as string).length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`carries every interpolation the surface passes — ${name}`, () => {
      for (const { key, vars } of KEYS) {
        if (vars === undefined) continue;
        const value = lookup(bundle, key) as string;
        for (const variable of vars) {
          expect(value, `${name}: ${key} needs {{${variable}}}`).toContain(
            `{{${variable}}}`
          );
        }
      }
    });
  }

  it("has the same keys on both sides, so neither bundle drifts", () => {
    expect([...paths(zh)].sort()).toEqual([...paths(en)].sort());
  });

  /**
   * The flap strings are **deliberately identical in every locale**. Not an
   * oversight: `BOARD_CHARS` is Latin by construction, a property of the
   * physical object rather than of the app, so a translated word folds to
   * nothing and `FlapWord` would paint a row of blank flaps. The translated
   * sentence lives in `flaps_label` and in the prose beside the board.
   */
  it("keeps the flap words identical across locales", () => {
    for (const key of FLAP_KEYS) {
      expect(lookup(zh, key), key).toBe(lookup(en, key));
    }
  });

  it("keeps the flap words settable on a real board", () => {
    for (const key of FLAP_KEYS) {
      const word = lookup(en, key) as string;
      // Survives the charset fold unchanged — no character silently dropped.
      expect(normalizeText(word), key).toBe(word);
      // And fits one row, so the band never wraps mid-word.
      expect(word.length, `${key} must fit ${BOARD_COLS} columns`).toBeLessThanOrEqual(
        BOARD_COLS
      );
    }
  });

  /**
   * The regression guard for what this surface replaced: a context panel whose
   * own docstring said it existed "so engineers evaluating the boilerplate
   * immediately see what's powering the auth flow", four stack pills, and a
   * promise that a visitor would land on a "role-gated dashboard" — a page
   * deleted in phase 2.
   */
  it("says nothing about the starter template it was forked from", () => {
    for (const [name, bundle] of BUNDLES) {
      const copy = JSON.stringify(bundle);
      for (const ghost of [
        "Better Auth",
        "Drizzle",
        "Cloudflare",
        "CloudFlare",
        "Workers",
        "Effect TS",
        "boilerplate",
        "起步包",
        "dashboard",
        "仪表盘",
        "OAuth",
        "CSRF",
      ]) {
        expect(copy, `${name} still mentions ${ghost}`).not.toContain(ghost);
      }
    }
  });
});
