# Feature: App IA & Navigation

_Last updated: 2026-07-31_

## Purpose
Phase 2 of the approved brand/IA/UX redesign (see `.brain/transcripts/` decision log referenced from `brand-system`'s changelog and `.brain/features/brand-system/brand-system.md`). Deletes `/dashboard` — brand-system's own shipped copy calls it "the post-auth landing page of the boilerplate," and its four explore cards are all `disabled={!isAdmin}` — deletes the six broken `/:lng` alias routes, reduces `/boards` from 560 lines to a thin switcher, and builds the shared management shell (header + user menu). Adds sign-out for non-admin users: `authClient.signOut()` currently exists in exactly one file, `admin/layout/nav-user.tsx:49`, so household (non-admin) users have no way to sign out today. Adds a pure `resolveSignedInHome(boardCount)` helper beside `resolveAutoLink`'s precedent, and redirect shims so no existing URL 404s.

Phase 3 (`console-journey-v2`, feat-020 — see `.brain/features/console-journey-v2/console-journey-v2.md`) ships in the SAME PR as this feature, by owner decision: the board-detail surface this phase would otherwise split into `/boards/:boardId` is exactly what phase 3 folds into the controller as a Settings tab. Building them apart would mean creating `/boards/:boardId` and then deleting it a PR later.

## When It's Used
- Every authenticated page load — the management shell (header + user menu) wraps the app surface
- Post-login / post-signup redirect resolution via `resolveSignedInHome(boardCount)`
- Any household (non-admin) user needing to sign out
- Any request to a legacy `/:lng` alias or `/dashboard` — must redirect via shim, never 404

## How It Works
Narrative TBD by the engineer during implementation. Record here: which route/loader owns the `/boards` thin-switcher logic, where `resolveSignedInHome` lives and what calls it, how the management shell composes header + user menu, and where the redirect shims live (loader-level 302s, not client-side).

### Persistence details
No new persistence expected — this is a routing/IA feature. If any is introduced (e.g. shim mapping table), record it here.

### Testability
Unit test `resolveSignedInHome(boardCount)` as a pure function (0 boards / 1 board / N boards), following `resolveAutoLink`'s precedent. Unit test the redirect shims (old path -> new path, no 404). Feature-verifier browser walk required before ship — see Acceptance Criteria #4 below for the measured step counts it must confirm. Verdict lands at `.brain/features/app-ia/verifications/<date>.md`.

## Key Files

| File | Role |
|------|------|
| `app/routes/dashboard/...` | DELETED — post-auth landing page, four explore cards all `disabled={!isAdmin}` |
| `app/routes/*/:lng/...` (six alias routes) | DELETED — broken `/:lng` catch-all aliases |
| `app/routes/boards/...` | Reduced from 560 lines to a thin switcher |
| `app/admin/layout/nav-user.tsx:49` | Existing sole location of `authClient.signOut()` — sign-out needs to reach non-admin users too |
| `app/lib/resolve-signed-in-home.ts` (or similar, TBD) | New pure `resolveSignedInHome(boardCount)` helper |
| `app/lib/resolve-auto-link.ts` | Precedent pattern for the new helper; NOT deleted by this feature (deleted by console-journey-v2) |

## Dependencies
- Effect services consumed: none new expected (pure routing/IA layer); confirm during implementation
- Depends on `brand-system` (feat-019) — shipped tokens/radius/pigment contract this feature must render on
- `console-journey-v2` (feat-020) depends on this feature — the management shell and redirect shims this feature builds are load-bearing for phase 3

## Tagged Errors
None expected — this is a routing/IA feature, not a new data boundary. If a redirect-shim or IA change introduces a new tagged error, record it here and map it in `app/lib/effect-trpc.ts`.

| Error | Where raised | tRPC code |
|-------|--------------|-----------|
| — | — | — |

## Acceptance Criteria

Carried forward from `brand-system`'s (feat-019) `design-critic` phase-1 P1 findings — accepted and deferred to this PR (and to `console-journey-v2`, shipped in the same PR). These are BLOCKING, not advisory.

1. **Enforce the radius/elevation contract on every surface this PR touches.** The tokens changed in phase 1 but the shadcn component defaults that violate the contract did not: `Card` is `rounded-xl` + `shadow-sm`, `Badge` is `rounded-full`. Oxide's named trait in the reference lock is "elevation via hairlines, never drop shadows"; `/boards` currently renders ~4-5px cards with a ~4px blur drop shadow and ~15 fully-rounded pills per viewport.
2. **The app surface and the hardware surface must read as one product.** They currently do not — card-and-shadow vs tonal ladder, pills vs sharp segmented controls, zero pigments vs eight.
3. **Spend the pigments.** The critic's sharpest line: they are tokenized but unspent, so the only colour in the product is a chip row three scrolls into one screen and everything a viewer meets first is monochrome. (The flap-rendered pairing code on `/tv` is where `console-journey-v2` changes this; this feature's job is to not re-introduce monochrome-only surfaces in the shell/header/user-menu it builds.)
4. **Step counts must be measured, not asserted**, by the `feature-verifier` walk: new user -> board on TV 5 stops/5 taps -> 3/3; returning owner -> change the message 3 stops -> 1, 2 taps -> 0 before typing; second TV 2 stops/4 taps -> 1/2. (Full journey spans both `app-ia` and `console-journey-v2`; this feature owns the entry/IA legs of that walk.)

## Load-Bearing Constraints (must not break)

From the approved 4-phase redesign plan — verify these explicitly in the feature-verifier walk before ship:

- `/b/:boardId`, `/b/:boardId/c`, `/tv`, `/tv/claim` paths are FROZEN — a wall-mounted TV may never reload, and the TV bakes the controller URL into the QR it re-mints from its own loader.
- The `/link` approve stays server-side inside a GET loader; the JavaScript-disabled submit contract is verified and must stay verified.
- Rollback-on-approve-failure must survive.
- `safeNextPath` rejects `//host`, scheme URLs and empties.
- Moving `requireSession` into a layout does NOT protect POSTs — React Router runs the leaf action only, so every board action keeps its own `requireSession` check. This is an auth hole if fumbled, and this feature is exactly the kind of change (shell/layout restructuring) that risks it.
- `defaultBoardName` keeps its signature and tests.
- `board-locale-parity.test.ts`'s `BOARDS_KEYS` covers only seven keys (the revoke dialog). Extend it BEFORE moving any copy so it fails first, not after.
- Board render stays frozen.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-31 | feature | Scoped and started as phase 2 of the brand/IA/UX redesign; status flipped to in-progress. |

## What shipped (2026-07-31)

Built as one PR with `console-journey-v2` on `feat/app-journey-v2`.

### Deleted

| Thing | Why |
|---|---|
| `app/routes/dashboard/{_layout,_index}.tsx` | A signed-in landing page whose only job was to link elsewhere, with four cards all `disabled={!isAdmin}` |
| `app/locales/{en,zh}/dashboard.json`, the `dashboard` namespace | Went with the route |
| The six `/:lng` alias routes | `...prefix(":lng", [index(...)])` matched **any** single segment, so `/pricing` served the marketing page with a 200 |
| `app/components/boards/*` (6 files) | The board manager moved onto the controller's Settings tab as console controls |

### Added

- **`resolveSignedInHome(boards)`** in `app/lib/session.ts` — pure, unit-tested at all three branches. Takes the boards rather than the `boardCount` the plan named: a count cannot address `/b/:boardId/c`, and a helper answering "the rack, or somewhere I can't tell you" pushes the interesting half back to every caller. Called from exactly one place, `home.tsx`'s loader — the only surface that both knows there is a session and can afford to list boards server-side, so the client-side auth forms navigate to `/` and let it decide.
- **`app/routes/legacy-redirect.ts`** — seven literal forwarding routes. `/dashboard` 302s (a product decision, reversible); `/en/*` and `/zh/*` 301 (duplicate-URL consolidation). Literal, **not** a `/:lng/*` splat: a splat would rebuild the soft-404 farm one status code over. Query survives the forward, because `/en/login?next=%2Flink%3Fcode%3D…` is a URL a QR-scanning visitor really lands on.
- **`ConsoleShell`** — the account bar. Carries the wordmark, language keys, the admin link and **sign-out for non-admins**, which no user could reach before: `authClient.signOut()` existed in exactly one file, behind the admin role gate.
- **A "Boards" entry in the admin sidebar** — `/admin` was a dead end.
- **`lastSeenKey`** moved from `components/boards/board-devices.tsx` into `lib/board/paired-devices.ts` with 6 unit tests. It was a helper with none, which is one of the five non-negotiables; the clock-ran-backwards case now has a test.

### Changed

- `/boards` is a **hardware-scoped rack**, not a manager: 560 lines → ~200. Each board wears its name in real flaps in a pigment derived from its id (`FlapWord` + `nameplatePigment`). Per-board device fetches are gone — that was one Durable Object round trip per board on the page a household opens standing up, and the count now lives beside the controls that change it.
- `requireAdmin` → `/boards`; `redirectIfAuthenticated` → `/`.
- `BOARDS_KEYS` in `board-locale-parity.test.ts` went from 7 keys (the revoke dialog only) to the full namespace, so every string that moved is guarded in both bundles.

### The trap that was not fallen into

Moving `requireSession` into a layout does **not** protect a POST — React Router runs the leaf `action` on its own. Every action kept its own gate, and `/link`'s says so in a comment.

### Evidence

`.brain/features/app-ia/verifications/2026-07-31.md` — PASS. `bunx playwright test` 6/6, including four tests that assert the migration itself. Harness 10/10.
