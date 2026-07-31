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
    await page.goto("/sign-up");
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

    // 3. Sign back in with the same credentials.
    await page.fill('[data-testid="login-email"]', email);
    await page.fill('[data-testid="login-password"]', password);
    await page.click('[data-testid="login-submit"]');
    await page.waitForURL("/boards");
    await expect(page.getByTestId("boards-empty")).toBeVisible();
  });

  test("login form rejects bad credentials", async ({ page }) => {
    await page.goto("/login");
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
    // A QR-scanning visitor can legitimately land on `/en/login?next=/link?...`,
    // and dropping `next` there strands them at the top of the app instead of at
    // the pairing they started.
    await page.goto("/en/login?next=%2Flink%3Fcode%3DGHPLXX");
    const url = new URL(page.url());
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/link?code=GHPLXX");
  });

  test("/pricing is a 404, not the marketing page", async ({ page }) => {
    // The deleted `...prefix(":lng", [index(...)])` matched ANY single segment,
    // so every unrouted path rendered the landing page with a 200 — a soft-404
    // farm across the whole URL space. This is the regression test for it.
    const response = await page.goto("/pricing");
    expect(response?.status()).toBe(404);
  });
});
