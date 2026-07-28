import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { describe, expect, it } from "vitest";

import { BoardOffline, offlineLabelKey } from "../board-offline";
import en from "@/locales/en/board.json";
import zh from "@/locales/zh/board.json";

/**
 * Same shape as the other tests in this folder: mostly a pure key + locale-parity
 * check, because vitest runs `environment: "node"` here and the repo carries no
 * jsdom and no `@testing-library/react`.
 *
 * What is new is that this one *does* render — through `renderToStaticMarkup`,
 * which needs no DOM at all (it is the same path that server-renders every route
 * in this app). That is enough to pin the two things about this component that
 * are behaviour rather than styling: a live board must render literally nothing,
 * and a dead one must announce itself politely without covering the grid.
 */

const BUNDLES: ReadonlyArray<readonly [string, unknown]> = [
  ["en", en],
  ["zh", zh],
];

/** `"status.retained"` → the string at that path, or `undefined`. */
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

/** Every status the display route can hand this component, plus one it can't. */
const STATUSES = ["connecting", "live", "reconnecting", "offline", "wat"] as const;

/** A real i18next instance, so the markup below carries real copy, not raw keys. */
const i18nFor = (locale: "en" | "zh") => {
  const instance = createInstance();
  void instance.use(initReactI18next).init({
    lng: locale,
    fallbackLng: "en",
    ns: ["board"],
    defaultNS: "board",
    resources: { en: { board: en }, zh: { board: zh } },
    interpolation: { escapeValue: false },
  });
  return instance;
};

const render = (status: string, locale: "en" | "zh" = "en"): string =>
  renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: i18nFor(locale) },
      createElement(BoardOffline, { status })
    )
  );

describe("offlineLabelKey", () => {
  it("uses the status chip's existing copy rather than a second set of strings", () => {
    expect(offlineLabelKey("connecting")).toBe("status.connecting");
    expect(offlineLabelKey("reconnecting")).toBe("status.reconnecting");
    expect(offlineLabelKey("offline")).toBe("status.offline");
  });

  it("calls an unrecognised status reconnecting rather than inventing a state", () => {
    // Rendering the raw key three metres wide is the failure mode here.
    expect(offlineLabelKey("wat")).toBe("status.reconnecting");
    expect(offlineLabelKey("")).toBe("status.reconnecting");
  });

  it.each(BUNDLES)("resolves every status to a real string in %s", (_locale, bundle) => {
    for (const status of STATUSES) {
      const key = offlineLabelKey(status);
      const copy = lookup(bundle, key);
      expect(copy, key).toBeTypeOf("string");
      expect(copy as string, key).not.toBe("");
    }
  });

  it.each(BUNDLES)("carries the retained-message line in %s", (_locale, bundle) => {
    const copy = lookup(bundle, "status.retained");
    expect(copy).toBeTypeOf("string");
    expect(copy as string).not.toBe("");
    // No interpolation — there is no revision or timestamp to promise.
    expect(copy as string).not.toContain("{{");
  });
});

describe("BoardOffline", () => {
  it("renders nothing at all on a live board", () => {
    expect(render("live")).toBe("");
  });

  it.each(["connecting", "reconnecting", "offline", "wat"])(
    "announces itself politely when the socket is %s",
    (status) => {
      const markup = render(status);
      expect(markup).toContain('data-testid="board-offline"');
      expect(markup).toContain('role="status"');
      expect(markup).toContain('aria-live="polite"');
      expect(markup).toContain(`data-status="${status}"`);
    }
  );

  it("shows the status copy and the retained-message line", () => {
    const markup = render("offline");
    expect(markup).toContain(en.status.offline);
    expect(markup).toContain(en.status.retained);
  });

  it("translates", () => {
    const markup = render("offline", "zh");
    expect(markup).toContain(zh.status.offline);
    expect(markup).toContain(zh.status.retained);
  });

  it("is a scrim over the grid, never a cover", () => {
    const markup = render("reconnecting");
    // A translucent black wash: the last message stays readable underneath, which
    // is the entire point — a board holding its last message is correct.
    expect(markup).toMatch(/bg-black\/\d+/);
    expect(markup).not.toContain("bg-black ");
    // It sits over the board without swallowing the display route's
    // any-gesture sound-unlock handler.
    expect(markup).toContain("pointer-events-none");
    expect(markup).toContain("absolute inset-0");
  });

  it("sizes itself in vmin like the rest of the kiosk surface", () => {
    const markup = render("offline");
    expect(markup).toMatch(/\[\d+(\.\d+)?vmin\]/);
    expect(markup).not.toMatch(/text-(xs|sm|base|lg|xl)\b/);
  });

  it("takes a className without losing the scrim", () => {
    const markup = renderToStaticMarkup(
      createElement(
        I18nextProvider,
        { i18n: i18nFor("en") },
        createElement(BoardOffline, { status: "offline", className: "opacity-90" })
      )
    );
    expect(markup).toContain("opacity-90");
    expect(markup).toContain('data-testid="board-offline"');
  });
});
