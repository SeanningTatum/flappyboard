import { redirect } from "react-router";

import type { Route } from "./+types/legacy-redirect";

/**
 * The forwarding address for URLs the IA redesign removed.
 *
 * Two families, and they are removed for different reasons, which is why they
 * get different status codes:
 *
 * - **`/dashboard`** — deleted outright. It was a signed-in landing page whose
 *   only job was to link elsewhere, and the redesign's first decision was that
 *   there is no such page: a household opens the app to change what the board
 *   says. `/` now resolves the real destination (see `resolveSignedInHome`), so
 *   that is where this points. **302**, because "there is no dashboard" is a
 *   product decision and a browser that cached it permanently would be a
 *   nuisance if it ever changed.
 *
 * - **`/en/*` and `/zh/*`** — the locale-prefixed aliases of `/`, `/login` and
 *   `/sign-up`. Locale has always been chosen by cookie (`/api/set-locale`,
 *   see `language-switcher.tsx`); the prefixes existed for SEO and were never
 *   the way anyone switched language. **301**, because consolidating duplicate
 *   URLs onto one canonical path is exactly what a permanent redirect is for.
 *
 * These are registered as **six literal routes**, not as a `/:lng/*` splat, and
 * that is the whole point of the file. The `...prefix(":lng", [index(...)])`
 * this replaces matched *any* single segment, so `/pricing` quietly rendered
 * the marketing page with a 200 — a soft-404 farm across the entire URL space.
 * A splat shim would rebuild it one status code over.
 */

/** `/en/login` → `/login`, `/zh` → `/`. Anything else is not routed here. */
export const stripLocalePrefix = (pathname: string): string => {
  const rest = pathname.replace(/^\/(?:en|zh)(?=\/|$)/, "");
  return rest === "" ? "/" : rest;
};

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);

  if (url.pathname === "/dashboard") {
    throw redirect(`/${url.search}`);
  }

  // The query survives the move: `/en/login?next=%2Flink%3Fcode%3D…` is a real
  // URL a QR-scanning visitor can arrive on, and dropping `next` there would
  // strand them at the top of the app instead of at the pairing they started.
  throw redirect(`${stripLocalePrefix(url.pathname)}${url.search}`, 301);
}
