import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TILE_COLORS } from "@/components/board/flap-tile";

/**
 * **Pigment parity between `TILE_COLORS` and `app/app.css`.** Renders nothing;
 * it asserts that two artifacts agree, the same way `board-locale-parity`
 * asserts the two locale bundles do.
 *
 * There are two copies of the flap palette on purpose. `TILE_COLORS` has to
 * stay a JS object of literal strings: the animator writes `paintFace` up to
 * 144 times per settle and `displayedGrid()` has to reason about real values to
 * compute a mid-travel retarget — an opaque `var(--flap-red)` string would
 * break both. The CSS block exists so a *stylesheet* can reach the same
 * pigments (the composer's colour chips, and anything later that needs a swatch
 * without importing a component).
 *
 * Two copies with no guard drift, and drift here is not cosmetic: the swatch on
 * the phone is a promise about what the television is going to do. A pigment
 * three points off is a promise the board does not keep.
 *
 * Note what this does NOT assert: that the CSS is *used*. It only pins the
 * values. If `--flap-*` ever stops having consumers, delete both the block and
 * this test rather than letting it rot into ceremony.
 */

const CSS_PATH = fileURLToPath(new URL("../../../app.css", import.meta.url));

/** `--flap-red: #c3352d;` → `{ "flap-red": "#c3352d" }`, comments stripped. */
const declaredFlapVars = (css: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(
    /--(flap-[a-z-]+)\s*:\s*([^;]+);/g
  )) {
    out[name] = value.trim().toLowerCase();
  }
  return out;
};

describe("flap pigment parity", () => {
  const css = readFileSync(CSS_PATH, "utf8");
  const declared = declaredFlapVars(css);

  it("declares a --flap-* variable for every distinct fill in TILE_COLORS", () => {
    // `black` and `white` deliberately share one fill — the unlit flap — so the
    // set of distinct fills is smaller than the set of colour names.
    const fills = new Set(
      Object.values(TILE_COLORS).map((c) => c.fill.toLowerCase())
    );
    const declaredValues = new Set(Object.values(declared));

    for (const fill of fills) {
      expect(
        declaredValues,
        `no --flap-* in app.css carries the fill ${fill}`
      ).toContain(fill);
    }
  });

  it.each([
    ["flap-red", "red"],
    ["flap-orange", "orange"],
    ["flap-yellow", "yellow"],
    ["flap-green", "green"],
    ["flap-blue", "blue"],
    ["flap-violet", "violet"],
  ] as const)("--%s matches TILE_COLORS.%s.fill", (cssVar, colour) => {
    expect(declared[cssVar]).toBe(TILE_COLORS[colour].fill.toLowerCase());
  });

  it("--flap-unlit is the fill shared by the black and white tiles", () => {
    expect(TILE_COLORS.black.fill).toBe(TILE_COLORS.white.fill);
    expect(declared["flap-unlit"]).toBe(TILE_COLORS.black.fill.toLowerCase());
  });

  it("declares no --flap-* variable that TILE_COLORS does not back", () => {
    const fills = new Set(
      Object.values(TILE_COLORS).map((c) => c.fill.toLowerCase())
    );
    for (const [name, value] of Object.entries(declared)) {
      expect(fills, `--${name} is not a pigment any tile uses`).toContain(value);
    }
  });

  it("keeps the pigments theme-invariant — declared once, never re-declared", () => {
    // A red flap is red on a television in a lit room whatever the phone's
    // theme is. If a `--flap-*` ever appears twice, someone has given a pigment
    // a dark-mode variant, which is a category error.
    for (const name of Object.keys(declared)) {
      const occurrences = css.match(new RegExp(`--${name}\\s*:`, "g")) ?? [];
      expect(occurrences.length, `--${name} is declared more than once`).toBe(1);
    }
  });
});
