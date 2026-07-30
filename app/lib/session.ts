import { redirect, type AppLoadContext } from "react-router";

/**
 * The non-null shape returned by `context.auth.api.getSession(...)` once a
 * session exists. `AppLoadContext["auth"]` is Better Auth's `Auth` instance
 * (see `workers/app.ts`), so this type tracks whatever `createAuth` returns
 * without redeclaring it.
 */
export type Session = NonNullable<
  Awaited<ReturnType<AppLoadContext["auth"]["api"]["getSession"]>>
>;

/**
 * Where a gated page sends an anonymous visitor, and where login sends them
 * back to afterwards. Only same-origin absolute paths are honoured: a `next`
 * of `//evil.com` is scheme-relative and would turn the login redirect into an
 * open redirect, so anything that is not exactly `/…` is dropped. The second
 * character is checked against BOTH separators — the WHATWG parser normalises
 * `/\evil.com` to `//evil.com` on special schemes, so rejecting only `//`
 * leaves the same hole one keystroke over (Greptile pre-PR review, verified
 * against `new URL`).
 */
export const safeNextPath = (raw: string | null): string | null => {
  if (raw === null || raw === "") return null;
  if (!raw.startsWith("/")) return null;
  if (raw[1] === "/" || raw[1] === "\\") return null;
  return raw;
};

/**
 * `/login?next=<path+query>` for the URL being gated, so a visitor who was
 * headed somewhere real (a QR scan landing on `/link?code=…`) resumes there
 * after signing in instead of landing on the dashboard.
 */
export const loginRedirectUrl = (request: Request): string => {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  return `/login?next=${encodeURIComponent(next)}`;
};

/**
 * Loader auth gate: resolves the current session or redirects to `/login`
 * (carrying the gated URL as `?next=`). Centralizes the
 * `context.auth.api.getSession({ headers })` + redirect branching duplicated
 * across the admin/dashboard layouts and auth routes.
 */
export async function requireSession(
  request: Request,
  context: AppLoadContext
): Promise<Session> {
  const session = await context.auth.api.getSession({
    headers: request.headers,
  });
  if (!session) throw redirect(loginRedirectUrl(request));
  return session;
}

/**
 * Loader auth gate: resolves the current session and requires `role === "admin"`,
 * redirecting non-admins to `/dashboard` (and unauthenticated users to `/login`
 * via `requireSession`).
 */
export async function requireAdmin(
  request: Request,
  context: AppLoadContext
): Promise<Session> {
  const session = await requireSession(request, context);
  if (session.user.role !== "admin") throw redirect("/dashboard");
  return session;
}

/**
 * Loader guard for public-only routes (home, login, sign-up): redirects an
 * already-authenticated visitor to `to` (default `/dashboard`) instead of
 * rendering the route.
 */
export async function redirectIfAuthenticated(
  request: Request,
  context: AppLoadContext,
  to = "/dashboard"
): Promise<void> {
  const session = await context.auth.api.getSession({
    headers: request.headers,
  });
  if (session) throw redirect(to);
}
