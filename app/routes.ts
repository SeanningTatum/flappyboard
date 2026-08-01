import {
  type RouteConfig,
  index,
  route,
  prefix,
  layout,
} from "@react-router/dev/routes";

export default [
  // API Routes (no locale prefix)
  route("/api/trpc/*", "routes/api/trpc.$.ts"),
  route("/api/auth/*", "routes/api/auth.$.ts"),
  route("/api/upload-file", "routes/api/upload-file.ts"),
  route("/api/board-ws", "routes/api/board-ws.ts"),
  route("/api/transcribe", "routes/api/transcribe.ts"),
  route("/api/set-locale", "routes/api/set-locale.ts"),
  route("/api/tv-ws", "routes/api/tv-ws.ts"),

  // TV display — no locale prefix: a kiosk URL is typed once by hand
  route("/b/:boardId", "routes/board/display.tsx"),
  route("/b/:boardId/c", "routes/board/control.tsx"),

  // Device-code pairing. `/tv` is the shortest URL in the app on purpose: it is
  // typed with a remote control, one character at a time, by someone standing up.
  route("/tv", "routes/tv.tsx"),
  route("/tv/claim", "routes/tv.claim.ts"),
  // `/link` is the owner's side and is auth-gated by its own loader, same as
  // `/boards`. No locale prefix, for the same reason the board surfaces have none.
  route("/link", "routes/link.tsx"),

  // Public routes at root (default locale)
  index("routes/home.tsx"),
  route("/login", "routes/authentication/login.tsx"),
  route("/sign-up", "routes/authentication/sign-up.tsx"),

  // Board management — auth-protected, no locale prefix (same as /admin):
  // copy is translated client-side from the `boards` namespace.
  route("/boards", "routes/boards/_index.tsx"),

  /*
    Forwarding addresses for the URLs the IA redesign removed — `/dashboard`
    and the six locale-prefixed aliases. Six LITERAL routes, deliberately:
    `...prefix(":lng", [...])` matched any single segment, so `/pricing`
    rendered the marketing page with a 200. See `legacy-redirect.ts`.
  */
  route("/dashboard", "routes/legacy-redirect.ts", { id: "shim-dashboard" }),
  route("/en", "routes/legacy-redirect.ts", { id: "shim-en" }),
  route("/en/login", "routes/legacy-redirect.ts", { id: "shim-en-login" }),
  route("/en/sign-up", "routes/legacy-redirect.ts", { id: "shim-en-sign-up" }),
  route("/zh", "routes/legacy-redirect.ts", { id: "shim-zh" }),
  route("/zh/login", "routes/legacy-redirect.ts", { id: "shim-zh-login" }),
  route("/zh/sign-up", "routes/legacy-redirect.ts", { id: "shim-zh-sign-up" }),

  // Admin routes — client-side i18n only, no locale prefix
  ...prefix("admin", [
    layout("routes/admin/_layout.tsx", [
      route("/", "routes/admin/_index.tsx"),
      route("/users", "routes/admin/users.tsx"),
      route("/kitchen-sink", "routes/admin/kitchen-sink.tsx"),
    ]),
  ]),
] satisfies RouteConfig;
