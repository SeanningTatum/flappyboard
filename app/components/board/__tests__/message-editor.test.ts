import { describe, expect, it } from "vitest";

import en from "@/locales/en/board.json";
import zh from "@/locales/zh/board.json";

/**
 * The type-first editor's copy, asserted in both bundles.
 *
 * The editor renders every one of these through `t()`, and a missing key on a
 * phone shows the raw dotted path in the middle of the control panel. The
 * restructure moved several of them (the row-detail plate, the row-fill handles)
 * and added the interpolations they carry, so the parity check is here rather than
 * left to a translator noticing.
 */

/** `"control.paint.row"` → the string at that path, or `undefined`. */
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

/** Every key the editor asks for, with the interpolations it passes. */
const KEYS: ReadonlyArray<{ key: string; vars?: ReadonlyArray<string> }> = [
  { key: "control.editor.title" },
  { key: "control.editor.row_placeholder", vars: ["number"] },
  { key: "control.editor.row_detail", vars: ["number"] },
  { key: "control.editor.segment_placeholder" },
  { key: "control.editor.color_label" },
  { key: "control.editor.segment_color_label", vars: ["number"] },
  { key: "control.editor.align_label" },
  { key: "control.editor.clear" },
  { key: "control.editor.add_segment" },
  { key: "control.editor.remove_segment", vars: ["number"] },
  { key: "control.editor.align.left" },
  { key: "control.editor.align.center" },
  { key: "control.editor.align.right" },
  { key: "control.editor.align.spread" },
  { key: "control.preview.title" },
  { key: "control.preview.truncated" },
  { key: "control.paint.toggle" },
  { key: "control.paint.color_label" },
  { key: "control.paint.hint" },
  { key: "control.paint.cell", vars: ["row", "col", "color"] },
  { key: "control.paint.row", vars: ["row", "color"] },
  { key: "control.send" },
  { key: "control.sending" },
];

const BUNDLES: ReadonlyArray<readonly [string, unknown]> = [
  ["en", en],
  ["zh", zh],
];

describe("the editor's copy", () => {
  for (const [name, bundle] of BUNDLES) {
    it(`resolves every key the editor renders — ${name}`, () => {
      for (const { key } of KEYS) {
        const value = lookup(bundle, key);
        expect(typeof value, `${name}: ${key}`).toBe("string");
        expect((value as string).length, `${name}: ${key}`).toBeGreaterThan(0);
      }
    });

    it(`carries every interpolation the editor passes — ${name}`, () => {
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

  it("names every board colour in both bundles, since a swatch is one word", () => {
    for (const [name, bundle] of BUNDLES) {
      for (const color of [
        "white",
        "red",
        "orange",
        "yellow",
        "green",
        "blue",
        "violet",
        "black",
      ]) {
        expect(
          typeof lookup(bundle, `control.colors.${color}`),
          `${name}: control.colors.${color}`
        ).toBe("string");
      }
    }
  });
});
