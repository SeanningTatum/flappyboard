import flapFont from "@/assets/fonts/inter-flap-600.woff2?url";

/**
 * The flap face, preloaded — both auth URLs can render real tiles (the pairing
 * code, the TV address), and the face is `font-display: block` in `app.css`, so
 * the alternative to arriving early is a row of tiles painting nothing. Same
 * reasoning and the same `crossOrigin` caveat as `/`: fonts fetch in CORS mode
 * even same-origin, and a preload without it is a different request than
 * `@font-face` makes, so it warms nothing.
 *
 * **This lives in its own module, not in `auth-route.ts`.** `links` is a *client*
 * export, so React Router pulls whatever declares it into the browser bundle —
 * and `auth-route.ts` reaches `i18n.server`. Declaring it there took the whole
 * auth surface down with `Server-only module referenced by client`, which in a
 * dev server means an unhydrated page that still renders and still screenshots.
 */
export const authLinks = () => [
  {
    rel: "preload",
    href: flapFont,
    as: "font",
    type: "font/woff2",
    crossOrigin: "anonymous" as const,
  },
];
