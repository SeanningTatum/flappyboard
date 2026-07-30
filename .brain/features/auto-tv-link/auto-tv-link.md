# Feature: Auto TV Link

_Last updated: 2026-07-29_

**Status: shipped 2026-07-29** — owner decisions ratified: auto when
obvious (0 boards → create, 1 → pair, many → picker), skip naming entirely,
stacked on PR #8's branch. Browser-verified PASS (16 assertions, 6 scenarios):
[`verifications/2026-07-29.md`](verifications/2026-07-29.md). Depends on
feat-014 qr-first-tv-link.

## Purpose
feat-014 made the QR carry the code; the owner still had to stop at `/link` and
choose. This removes the stop: scan → sign in if needed → **the TV is linked**.
The loader auto-resolves the obvious cases — a fresh account gets a board made
for it (locale-aware default name, rename later in `/boards`), a one-board
account pairs that board — and only a genuinely ambiguous account (multiple
boards) sees the picker.

## When It's Used
- QR scan on a fresh account → board auto-created + paired, zero typing
- QR scan on a one-board account → that board paired
- QR scan on a multi-board account → the feat-014 picker (choice matters)
- Wrong guess / expired code → the manual form with the error named;
  `?manual=1` forces the picker

## How It Works
The `/link` loader (already session-gated with the `?next=` round-trip) reads
`?code=`; when it normalizes and `manual` is not set, it resolves
`resolveAutoLink(boardCount)` (pure, unit-tested): `create` | `single` |
`pick`. `create` runs `board.create({ name: defaultBoardName(locale) })` then
`approveDeviceCode`, with the same rollback discipline as the action (delete on
approve failure). `single` approves the one board. Any failure falls through
to the manual form with the failure named — never to a dead end.

GET-with-side-effect is deliberate and precedented: `/tv/claim` already redeems
a single-use credential in a loader, and the code *is* the authority gate —
the scan is the intent. This keeps auto-link working with JavaScript disabled.

### Testability
Unit: `resolveAutoLink` (0/1/many) + `defaultBoardName` (en/zh/fallback) — 6
tests in `app/routes/__tests__/link.test.ts`. Browser walk:
[`verifications/2026-07-29.md`](verifications/2026-07-29.md) — PASS, 16
assertions across 6 scenarios: fresh sign-up with 0 boards auto-creates
"Living Room" and pairs with zero interaction after registration (TV flips to
144 tiles, one HttpOnly `fb_device_` cookie); 1-board account auto-pairs with
the paired (not created) copy; multi-board account gets the picker; bogus
code falls to the form with not-found and no orphan board; `manual=1` escape
works from both directions; /tv regression clean.

## Key Files

| File | Role |
|------|------|
| `app/routes/link.tsx` | Loader auto-resolution + linked/form modes |
| `app/locales/{en,zh}/boards.json`, `board.json` | Auto copy + updated /tv instructions |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-29 | feature | Planned — owner ratified auto-when-obvious, skip naming, stacked PR |
| 2026-07-29 | feature | Shipped — scan → login → linked, zero typing in the obvious cases |
