import { test, expect } from "@playwright/test";

/**
 * Authentication golden path, plus the IA migration itself.
 *
 * Covers the only flow that genuinely matters end-to-end:
 *   1. New user signs up → `/` resolves their home → the rack, with no boards.
 *   2. User signs out → bounced to `/login` when revisiting `/boards`.
 *   3. Same user signs in → back to the rack.
 *
 * The four `/dashboard` waits this file used to make were not incidental: that
 * page no longer exists, and `resolveSignedInHome` is what replaced it. So the
 * migration gets **asserted rather than merely accommodated** — `/dashboard` and
 * the locale aliases must forward, and `/pricing` must 404 rather than serving
 * the marketing page, which is what the deleted `/:lng` prefix did for any
 * single-segment path.
 *
 * Other surfaces (admin, analytics) are gated by an admin role. `bun run
 * db:seed` seeds `admin@preview.local` / `Password123!` (plus a plain user and a
 * banned user) into local D1 — use those fixtures for admin-flow specs instead
 * of a direct D1 UPDATE.
 */
test.describe("Authentication", () => {
  // Each run uses a fresh email so re-runs against a persistent local D1
  // don't collide with the previous run's user.
  const email = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.local`;
  const password = "E2EPass123!";
  const name = "E2E User";

  test("signup → rack, signout → login, signin → rack", async ({ page }) => {
    // 1. Sign up. A brand-new account has no boards, so `resolveSignedInHome`
    //    sends it to the rack rather than to a controller.
    // `networkidle` before touching anything. The forms declare
    // `method="post"` so that a pre-hydration submit cannot put a password in
    // the URL — which means a click that lands before React attaches does a
    // real POST to a route with no action, and the page answers 405 instead of
    // rendering the inline error. That raced ~50% of the time against a warm
    // dev server. Waiting is the fix in the test, not in the app: the app's
    // behaviour there is deliberate and correct.
    await page.goto("/sign-up", { waitUntil: "networkidle" });
    await page.fill('[data-testid="signup-name"]', name);
    await page.fill('[data-testid="signup-email"]', email);
    await page.fill('[data-testid="signup-password"]', password);
    await page.fill('[data-testid="signup-confirm-password"]', password);
    await page.click('[data-testid="signup-submit"]');
    await page.waitForURL("/boards");
    await expect(page.getByTestId("boards-empty")).toBeVisible();

    // The rack teaches the one thing a household with no screens needs: the
    // address to type into a television.
    await expect(page.getByTestId("boards-pairing-address")).toContainText(
      "/tv"
    );

    // 2. Sign out — from the shell's account menu, not from a fetch. This is the
    //    control a non-admin had no way to reach before the redesign, so an
    //    endpoint-level sign-out would test the wrong thing.
    await page.click('[data-testid="console-shell-account"]');
    await page.click('[data-testid="console-shell-sign-out"]');
    await page.waitForURL("/login");

    await page.goto("/boards");
    await page.waitForURL(/\/login\?next=/);
    await page.waitForLoadState("networkidle");

    // 3. Sign back in with the same credentials.
    await page.fill('[data-testid="login-email"]', email);
    await page.fill('[data-testid="login-password"]', password);
    await page.click('[data-testid="login-submit"]');
    await page.waitForURL("/boards");
    await expect(page.getByTestId("boards-empty")).toBeVisible();
  });

  test("login form rejects bad credentials", async ({ page }) => {
    await page.goto("/login", { waitUntil: "networkidle" });
    await page.fill('[data-testid="login-email"]', "nobody@test.local");
    await page.fill('[data-testid="login-password"]', "WrongPass123!");
    await page.click('[data-testid="login-submit"]');
    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("Removed URLs", () => {
  test("/dashboard forwards to the index, which resolves the real home", async ({
    page,
  }) => {
    const response = await page.goto("/dashboard");
    // Anonymous, so the index renders the landing page rather than redirecting
    // on to a board. What matters is that `/dashboard` is no longer a page.
    expect(new URL(page.url()).pathname).toBe("/");
    expect(response?.status()).toBe(200);
  });

  test("the locale aliases forward to their canonical paths", async ({
    page,
  }) => {
    await page.goto("/en/login");
    expect(new URL(page.url()).pathname).toBe("/login");

    await page.goto("/zh");
    expect(new URL(page.url()).pathname).toBe("/");
  });

  test("a locale alias keeps ?next= across the forward", async ({ page }) => {
    // A gated visitor can legitimately land on `/en/login?next=…`, and dropping
    // `next` there strands them at the top of the app instead of where they
    // were going.
    //
    // `next` is `/boards` rather than the `/link?code=…` this test used to
    // carry: a pairing `next` now lands on `/sign-up` (see the next test), which
    // would make this assertion about two behaviours at once and fail for the
    // wrong reason if either moved.
    await page.goto("/en/login?next=%2Fboards");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/boards");
  });

  test("/pricing is a 404, not the marketing page", async ({ page }) => {
    // The deleted `...prefix(":lng", [index(...)])` matched ANY single segment,
    // so every unrouted path rendered the landing page with a 200 — a soft-404
    // farm across the whole URL space. This is the regression test for it.
    const response = await page.goto("/pricing");
    expect(response?.status()).toBe(404);
  });
});

test.describe("Pairing arrivals", () => {
  test("an anonymous QR scan lands on sign-up, code intact and in flaps", async ({
    page,
  }) => {
    // The real journey, driven end to end rather than asserted on a hand-built
    // URL: `/tv` prints a code, the phone scans `/link?code=…`, `requireSession`
    // gates it. Somebody who minted that code on their own television seconds
    // ago has no account, so a password field is the wrong thing to show them.
    await page.goto("/link?code=GHPLXX", { waitUntil: "networkidle" });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/sign-up");
    expect(url.searchParams.get("next")).toBe("/link?code=GHPLXX");
    await expect(page.getByTestId("signup-form")).toBeVisible();

    // The code itself is on the page, set in real flaps, so the six characters
    // on the phone can be compared with the six on the television.
    await expect(page.getByTestId("auth-flaps")).toHaveAttribute(
      "data-text",
      "GHPLXX"
    );

    // And "Sign in" is one tap away for a returning owner adding a second
    // television — carrying `next`, and NOT bouncing back here. An earlier pass
    // put this redirect in `/login`'s loader and made that toggle a dead
    // control; this assertion is the regression guard.
    await page.click('[data-testid="auth-mode-sign-in"]');
    await page.waitForURL(/\/login\?next=/);
    expect(new URL(page.url()).searchParams.get("next")).toBe(
      "/link?code=GHPLXX"
    );
    await expect(page.getByTestId("login-form")).toBeVisible();
    await expect(page.getByTestId("auth-flaps")).toHaveAttribute(
      "data-text",
      "GHPLXX"
    );
  });

  test("a gated page with no code still bounces to sign-in", async ({
    page,
  }) => {
    await page.goto("/boards", { waitUntil: "networkidle" });
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/boards");
    await expect(page.getByTestId("login-form")).toBeVisible();
  });

  test("an off-origin next cannot steer the redirect", async ({
    page,
    baseURL,
  }) => {
    // `safeNextPath` rejects `//host` before the code is ever read, so this is
    // an ordinary sign-in page with a `next` that will be dropped — not a
    // redirect to somebody else's origin. The pairing branch is a new place
    // `next` is read, so it gets its own guard rather than trusting the unit
    // test alone.
    await page.goto("/login?next=%2F%2Fevil.com%2Flink%3Fcode%3DGHPLXX");
    const url = new URL(page.url());
    expect(url.origin).toBe(new URL(baseURL!).origin);
    expect(url.pathname).toBe("/login");
    await expect(page.getByTestId("login-form")).toBeVisible();
  });
});
