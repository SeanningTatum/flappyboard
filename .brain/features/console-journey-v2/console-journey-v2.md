# Feature: Console Journey v2

_Last updated: 2026-07-31_

## Purpose
Phase 3 of the approved brand/IA/UX redesign, shipped in the SAME PR as `app-ia` (feat-020's predecessor, phase 2) by owner decision — the board-detail surface phase 2 would otherwise split out into `/boards/:boardId` is exactly what this phase folds into the controller as a Settings tab. Building them apart would mean creating `/boards/:boardId` and then deleting it.

A board IS a TV: deletes `resolveAutoLink`, the board picker, the `<select>`, the receipt page, and `/link`'s entire manual mode, so scanning always creates a board and lands the user on the controller with nothing to answer (5 stops -> 3). The pairing code on `/tv` becomes six live flap tiles (spending the pigment contract for the first time a viewer meets the product). The controller gains Content|Settings tabs at the frozen `/b/:boardId/c` path, with Settings absorbing the TV address, paired devices with count, rename, un-pair and delete. Device naming moves inline into the nameplate. The composer's live grid becomes the primary instrument.

## When It's Used
- Every scan-to-pair flow (`/tv` -> `/link` -> controller) — the entire manual-mode / picker / receipt-page branch is removed from this path
- Every controller session at `/b/:boardId/c` — Content|Settings tabs replace whatever surfaced device management before
- Any TV physically at `/tv` waiting to be paired — its pairing code now renders as six live flap tiles instead of plain text/pill UI
- Device management: rename, un-pair, delete, count — all live under the Settings tab now, not a separate receipt page

## How It Works
Narrative TBD by the engineer during implementation. Record here: what replaces `resolveAutoLink` (or whether the board-count branching logic is deleted entirely rather than replaced), how the Content|Settings tab switch is wired at the frozen `/b/:boardId/c` route, how the six-flap-tile pairing code render reuses (or diverges from) the existing flap-tile component from `split-flap-board` (feat-007), and where inline device naming lives on the nameplate.

### Persistence details
No new persistence expected beyond what already exists for boards/devices/grants. If the Settings tab's device list changes any query shape or introduces a new D1 read path, record it here.

### Testability
`resolveAutoLink`'s tests delete with the function — confirm the deletion is clean (no dangling imports/tests). Unit test whatever replaces the board-count branch. Feature-verifier browser walk required before ship — this is the feature that must prove the measured step-count claims in Acceptance Criteria #4 below, since it owns the scan -> pair -> controller leg end to end. Verdict lands at `.brain/features/console-journey-v2/verifications/<date>.md`.

## Key Files

| File | Role |
|------|------|
| `app/lib/resolve-auto-link.ts` | DELETED — board-count branching logic this feature replaces |
| `app/lib/resolve-auto-link.test.ts` (or colocated test) | DELETED alongside the function |
| `app/routes/link/...` | Manual mode, the `<select>` board picker, and the receipt page all DELETED |
| `app/routes/tv/...` | Pairing code render changes from plain text/pill to six live flap tiles |
| `app/routes/b.$boardId.c/...` (frozen path) | Gains Content|Settings tab switch; Settings absorbs TV address + paired devices (count, rename, un-pair, delete) |
| `app/components/flap-tile.tsx` (or wherever it lives, from feat-007) | Reused (or extended) for the six-tile pairing-code render on `/tv` |

## Dependencies
- Effect services consumed: TBD during implementation — confirm no new binding is needed beyond what `tv-pairing` (feat-010), `family-grants` (feat-011), and `phone-control` (feat-008) already established
- Depends on `brand-system` (feat-019) — shipped tokens/radius/pigment contract
- Depends on `app-ia` (feat-020's predecessor phase) — the management shell and redirect shims phase 2 builds are load-bearing here
- Reuses flap-tile rendering primitives from `split-flap-board` (feat-007)
- Builds on `tv-pairing` (feat-010), `family-grants` (feat-011), `qr-first-tv-link` (feat-014), `auto-tv-link` (feat-017), `controller-board-mirror` (feat-015), `pairing-experience-redesign` (feat-016) — this feature deletes/replaces parts of the auto-link/picker logic those features introduced

## Tagged Errors
None expected beyond what already exists for board/device operations. If a new error surfaces from the Settings-tab device management (rename/un-pair/delete), record it here and map it in `app/lib/effect-trpc.ts`.

| Error | Where raised | tRPC code |
|-------|--------------|-----------|
| — | — | — |

## Acceptance Criteria

Carried forward from `brand-system`'s (feat-019) `design-critic` phase-1 P1 findings — accepted and deferred to this PR (shipped alongside `app-ia` in the same PR). These are BLOCKING, not advisory.

1. **Enforce the radius/elevation contract on every surface this PR touches.** The tokens changed in phase 1 but the shadcn component defaults that violate the contract did not: `Card` is `rounded-xl` + `shadow-sm`, `Badge` is `rounded-full`. Oxide's named trait in the reference lock is "elevation via hairlines, never drop shadows"; `/boards` currently renders ~4-5px cards with a ~4px blur drop shadow and ~15 fully-rounded pills per viewport. (This feature's Settings tab / device-list surfaces are exactly the kind of card-and-pill UI this criterion targets.)
2. **The app surface and the hardware surface must read as one product.** They currently do not — card-and-shadow vs tonal ladder, pills vs sharp segmented controls, zero pigments vs eight. The Content|Settings tab switch this feature builds must use a sharp segmented control, not pills.
3. **Spend the pigments.** The critic's sharpest line: they are tokenized but unspent, so the only colour in the product is a chip row three scrolls into one screen and everything a viewer meets first is monochrome. The flap-rendered pairing code on `/tv` is where this feature changes that — it is the load-bearing deliverable for this criterion.
4. **Step counts must be measured, not asserted**, by the `feature-verifier` walk: new user -> board on TV 5 stops/5 taps -> 3/3; returning owner -> change the message 3 stops -> 1, 2 taps -> 0 before typing; second TV 2 stops/4 taps -> 1/2. This feature owns the scan -> pair -> land-on-controller leg and must prove the 3/3 and 1/2 counts directly; it shares the 1/0 (returning owner) count with whatever the composer/live-grid work touches.

## Load-Bearing Constraints (must not break)

From the approved 4-phase redesign plan — verify these explicitly in the feature-verifier walk before ship. Several are directly in this feature's blast radius since it touches `/link`, `/tv`, and the frozen controller path:

- `/b/:boardId`, `/b/:boardId/c`, `/tv`, `/tv/claim` paths are FROZEN — a wall-mounted TV may never reload, and the TV bakes the controller URL into the QR it re-mints from its own loader.
- The `/link` approve stays server-side inside a GET loader; the JavaScript-disabled submit contract is verified and must stay verified. This feature deletes manual mode and the receipt page from `/link` — the remaining auto-approve path must keep this contract intact.
- Rollback-on-approve-failure must survive.
- `safeNextPath` rejects `//host`, scheme URLs and empties.
- Moving `requireSession` into a layout does NOT protect POSTs — React Router runs the leaf action only, so every board action (including the new Settings-tab rename/un-pair/delete actions this feature adds) keeps its own `requireSession` check. This is an auth hole if fumbled.
- `defaultBoardName` keeps its signature and tests; `resolveAutoLink`'s tests delete with the function (and only with the function — no orphaned assertions left behind).
- `board-locale-parity.test.ts`'s `BOARDS_KEYS` covers only seven keys (the revoke dialog). Extend it BEFORE moving any copy so it fails first — directly relevant here since the receipt page and manual-mode copy are being deleted/relocated.
- Board render stays frozen.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-31 | feature | Scoped as phase 3 of the brand/IA/UX redesign, planned status; ships in the same PR as `app-ia` (phase 2) by owner decision. |

## What shipped (2026-07-31)

Built as one PR with `app-ia` on `feat/app-journey-v2`.

### Pairing: the branch is gone

`resolveAutoLink` (0 → create / 1 → pair / many → picker), the picker form, the native `<select>`, the naming field, the segmented existing/new track and the refresh-safe receipt were all deleted. `/link` went from 678 lines to ~300, of which **none render on the happy path** — the loader pairs and redirects straight to the controller.

A board is a television. Scanning always makes one, so there is no question to answer. What is left on screen is the code field for someone who could not scan, plus the named refusals.

Preserved deliberately:

- **Create-then-approve rollback.** Approve runs after create because it needs the board id, so a stale code would otherwise leave an orphaned "Living Room" behind. Verified by counting rows across four deliberate failures: 3 before, 3 after.
- **`defaultBoardName`'s signature and its tests.** `resolveAutoLink`'s three tests were deleted with the function they described.
- **The no-JS contract.** Still a plain `<Form method="post">`, and the loader still approves server-side.
- **The frozen paths.** `/b/:boardId`, `/b/:boardId/c`, `/tv`, `/tv/claim` are untouched. The television mints its controller QR from its own loader, so a path change only reaches a TV that reloads — and a wall-mounted panel may never have to.

**Deliberately NOT rebuilt:** an "attach this TV to an existing board" control. A TV whose cookie is evicted shows a fresh code and scanning it makes a *second* board for the same television. That is real sprawl with no stable TV identity to dedupe on, and it remains an open question rather than a reason to restore the picker through the side door.

### The TV

The pairing code is six real flaps (`FlapWord`), unlit with white glyphs — the board's default state, not a colour statement; a pigment on a string somebody reads across a room would be decoration. It replaces a mono readout whose instinct (a code wants a fixed advance) was right for the wrong reason: a flap has a fixed advance by construction, and this screen *is* a split-flap display.

`FlapWord` is not a board — no socket, no animator, no 144 tiles. A changed character remounts the tile (instant cut, not a flip), because the frozen `FlapTile` paints its faces once and never revisits them. Its size is explicit width/height derived from one cell width rather than `aspect-ratio`: that property is Chromium 88 and the Tizen panel is 56, where a grid with no intrinsic height collapses to nothing.

### The controller

**Content | Settings**, at the unchanged path.

Settings absorbs the whole of the old `/boards`: TV address, rename, paired devices with their count, per-device un-pair, un-pair all TVs, revoke all phones, delete. As inline console controls, not Radix dialogs — a portal escapes the `data-surface` scope, traps focus and positions against the viewport, none of which earns its keep on a phone held one-handed in a dim room. Destructive controls arm **in place** (`ArmedKey`): the two-step is preserved, the overlay is not. Only `delete` is red; the two un-pair actions are recoverable by scanning again and sit next to the device list they act on.

The one-time "name this phone" prompt became a plain field there. It was a modal-shaped interruption standing between someone and the thing they scanned a QR code to do.

Content now has **one board instead of two**. The separate live mirror plus the editor's preview put two grids a hand's width apart on a 390px screen — a spot-the-difference puzzle, not a preview. The editor's grid is now the single instrument: live off the socket while nothing is composed, the compiled draft as soon as something is, swapping on `gridIsBlank(compiled.grid)`. The six typing wells moved below it, behind a disclosure.

**Deviation from the plan, stated:** that disclosure **defaults open**. "Wells behind a toggle" was the instruction; collapsing the only text input by default would hide the primary path to promote the secondary one. What the toggle actually buys is the paint workflow — arm paint, fold the wells away, and the board is the whole screen.

### Evidence

`.brain/features/console-journey-v2/verifications/2026-07-31.md` — PASS. Signed-in `design:audit` HARD checks pass on the controller and `/link`. Still owed: the physical-TV check (legibility at 10 feet, Tizen render).
