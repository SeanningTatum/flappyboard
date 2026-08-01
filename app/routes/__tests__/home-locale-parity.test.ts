import { describe, expect, it } from "vitest";

import en from "@/locales/en/home.json";
import zh from "@/locales/zh/home.json";

/**
 * **Locale-key parity for the front door.** This file renders nothing — it
 * asserts that every key the landing page asks `t()` for exists in *both*
 * bundles, and that the page it replaced cannot come back through the copy.
 *
 * Worth a test rather than a review: a missing key on the one page a stranger
 * sees renders the raw dotted path as a headline, and neither that nor a `zh`
 * bundle that quietly kept an English sentence is a type error.
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

/** Every key `home.tsx` renders, with the interpolations it passes. */
const KEYS: ReadonlyArray<{ key: string; vars?: ReadonlyArray<string> }> = [
  { key: "meta.title" },
  { key: "meta.description" },
  { key: "brand" },
  { key: "lede.title" },
  { key: "lede.body" },
  { key: "lede.screensaver" },
  { key: "say.label" },
  { key: "say.placeholder" },
  { key: "say.counter", vars: ["used", "capacity"] },
  { key: "say.hint.dropped" },
  { key: "say.hint.nothing" },
  { key: "say.hint.full" },
  { key: "cta.primary" },
  { key: "cta.have_one" },
  { key: "cta.sign_in" },
  { key: "tv.label" },
  { key: "tv.body" },
  { key: "specs.title" },
  { key: "specs.caption" },
  { key: "footer.note" },
];

/** Mirrors `SPEC_ROWS` in `home.tsx`. `address` prints the loader's own origin. */
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

const BUNDLES: ReadonlyArray<readonly [string, unknown]> = [
  ["en", en],
  ["zh", zh],
];

describe("the landing page's copy", () => {
  for (const [name, bundle] of BUNDLES) {
    it(`resolves every key the page renders — ${name}`, () => {
      for (const { key } of KEYS) {
        const value = lookup(bundle, key);
        expect(typeof value, `${name}: ${key}`).toBe("string");
        expect((value as string).length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`carries every interpolation the page passes — ${name}`, () => {
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

    it(`labels every spec row, and values for all but the address — ${name}`, () => {
      for (const row of SPEC_ROWS) {
        expect(
          typeof lookup(bundle, `specs.rows.${row}.label`),
          `${name}: specs.rows.${row}.label`
        ).toBe("string");
        if (row === "address") continue;
        expect(
          typeof lookup(bundle, `specs.rows.${row}.value`),
          `${name}: specs.rows.${row}.value`
        ).toBe("string");
      }
    });
  }

  it("has the same keys on both sides, so neither bundle drifts", () => {
    expect([...paths(zh)].sort()).toEqual([...paths(en)].sort());
  });

  /**
   * The regression guard for what this page replaced: a landing page that
   * printed `/start-task`, `.brain/recipes/` and `bun install` at families
   * looking for a message board, under the title "Cloudflare SaaS Starter".
   */
  it("says nothing about the starter template it was forked from", () => {
    for (const [name, bundle] of BUNDLES) {
      const copy = JSON.stringify(bundle);
      for (const ghost of [
        "Cloudflare SaaS",
        "/start-task",
        ".brain",
        "bun install",
        "boilerplate",
        "Drizzle",
        "tRPC",
      ]) {
        expect(copy, `${name} still mentions ${ghost}`).not.toContain(ghost);
      }
    }
  });
});
