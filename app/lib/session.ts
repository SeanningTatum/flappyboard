import { Either } from "effect";
import { redirect, type AppLoadContext } from "react-router";

import { normalizeDeviceCode } from "@/lib/board/device-code";

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
 * A base that can never leak into the answer.
 *
 * `new URL(path, base)` needs *some* origin to resolve a relative path against,
 * and `.invalid` is reserved by RFC 2606 precisely so a placeholder host can
 * never resolve to a real one. Nothing from it is ever read back — only
 * `pathname` and `searchParams` are.
 */
const PAIRING_BASE = "http://pairing.invalid";

/**
 * The device code a `next` path is carrying, or `null`.
 *
 * This exists to answer one question at the front door: **has this visitor just
 * scanned the QR on their television?** `requireSession` gates `/link` and
 * bounces an anonymous scan to `/login?next=%2Flink%3Fcode%3D…`
 * (`loginRedirectUrl`), so the code is sitting right there in `next` — and
 * somebody who minted a code on a screen thirty seconds ago almost certainly
 * has no account yet. Landing them on a sign-in form asks them to remember a
 * password they never made.
 *
 * It runs `next` back through `safeNextPath` rather than trusting the caller to
 * have done it. The guard is the whole reason a `next` can be parsed at all
 * (`//evil.com` and `/\evil.com` are rejected there, and the WHATWG parser
 * normalises the second into the first on a special scheme), so re-applying it
 * costs two comparisons and removes an ordering hazard from every call site.
 *
 * `normalizeDeviceCode` rather than a regexp: it owns the alphabet, the length
 * and the deliberate refusal to substitute confusable glyphs, and a second
 * implementation of "is this a code" is a second place for those to drift.
 * A `next` that points anywhere but `/link`, or carries no readable code, is not
 * a pairing arrival.
 */
export const pairingCodeFromNext = (next: string | null): string | null => {
  const safe = safeNextPath(next);
  if (safe === null) return null;

  // `Either.try`, not `try/catch` — the repo's rule, and `new URL` is the one
  // call here that can throw at all.
  const parsed = Either.try({
    try: () => new URL(safe, PAIRING_BASE),
    catch: () => "unparseable" as const,
  });
  if (Either.isLeft(parsed)) return null;

  if (parsed.right.pathname !== "/link") return null;
  return normalizeDeviceCode(parsed.right.searchParams.get("code"));
};

/**
 * Where a gated page sends an anonymous visitor, carrying the URL it gated as
 * `?next=` so they resume there afterwards instead of landing on their board.
 *
 * **A pairing arrival goes to `/sign-up`, not `/login`.** Somebody who scanned
 * the QR on their own television seconds ago almost certainly has no account,
 * and a password field asks them to remember one they never made.
 *
 * The choice lives *here*, at the bounce, rather than in `/login`'s loader —
 * and that is not a stylistic preference. A `/login` that redirected pairing
 * arrivals onward would make its own sign-in/sign-up toggle a dead control in
 * exactly the case where somebody needs it: a returning owner adding a second
 * television taps "Sign in" and is bounced straight back to sign-up, forever.
 * Caught by the e2e spec, not by review. Deciding once, at the only place that
 * knows the visitor was *sent* rather than that they navigated, leaves both
 * URLs meaning precisely what they say.
 */
export const loginRedirectUrl = (request: Request): string => {
  const url = new URL(request.url);
  const next = `${url.pathname}${url.search}`;
  const destination = pairingCodeFromNext(next) === null ? "/login" : "/sign-up";
  return `${destination}?next=${encodeURIComponent(next)}`;
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
