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
 * after signing in instead of landing on their board.
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
 * redirecting non-admins to `/boards` (and unauthenticated users to `/login`
 * via `requireSession`).
 */
export async function requireAdmin(
  request: Request,
  context: AppLoadContext
): Promise<Session> {
  const session = await requireSession(request, context);
  if (session.user.role !== "admin") throw redirect("/boards");
  return session;
}

/**
 * Where a signed-in visitor lands when they open the app with nowhere
 * particular to be — the answer to "there is no dashboard any more, so what is
 * home?".
 *
 * **One board goes straight to its controller.** That is the whole point: a
 * household with one television has exactly one thing to do here, and making
 * them tap a list of length one to reach it is the friction the redesign
 * removed. Zero boards or several boards land on the rack, which either teaches
 * the TV address or asks which screen.
 *
 * Takes the boards rather than the `boardCount` the plan named, because a count
 * cannot address a controller — `/b/:boardId/c` needs the id, and a helper that
 * answers "the rack, or somewhere I can't tell you" would push the interesting
 * half back to every caller.
 *
 * Pure, and called from exactly one place (`routes/home.tsx`'s loader): it is
 * the only surface that both knows there is a session and can afford to list
 * boards server-side. The client-side auth forms navigate to `/` and let it
 * decide, so the rule lives in one file rather than in every form.
 */
export const resolveSignedInHome = (
  boards: ReadonlyArray<{ readonly id: string }>
): string =>
  boards.length === 1
    ? `/b/${encodeURIComponent(boards[0]!.id)}/c`
    : "/boards";

/**
 * Loader guard for public-only routes (login, sign-up): redirects an
 * already-authenticated visitor to `to` (default `/`, which resolves the real
 * destination via `resolveSignedInHome`) instead of rendering the route.
 */
export async function redirectIfAuthenticated(
  request: Request,
  context: AppLoadContext,
  to = "/"
): Promise<void> {
  const session = await context.auth.api.getSession({
    headers: request.headers,
  });
  if (session) throw redirect(to);
}
