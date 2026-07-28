# Feature: Family Grants

_Last updated: 2026-07-28_

**Status: planned.** Design approved in plan review round 1 —
`plans/2026-07-28-tv-living-room.html`.

## Purpose
Make a paired phone stay paired. Today `DEFAULT_GRANT_TTL_SECONDS = 12 * 60 * 60`
(`app/lib/board/pairing.ts:61`), so a household pairs after breakfast and
re-scans the QR after dinner. This feature raises that to **30 days, sliding**
(renewed on use — decision 3), and gives each paired device a **name captured
once at pairing, visible to the owner only** (decision 4) so revocation can be
per-device instead of all-or-nothing.

## When It's Used
- Every time a family member opens `/b/:boardId/c` — the grant renews silently.
- When the owner reviews or revokes paired devices from `/boards`.

## How It Works
- Grant TTL moves to 30 days. On each socket upgrade the grant is re-minted and
  re-set, so an actively used phone never expires while a guest's phone ages out
  on its own.
- Pairing captures an optional device name. That turns the grant from a purely
  stateless token into a per-grant record in the DO — the cost of decision 4,
  accepted because "un-pair Kai's phone" beats "bump the epoch and make everyone
  re-scan".
- The existing `grantEpoch` bump is kept as the blunt instrument: one action
  kills every controller at once.

### Persistence details
- Per-grant records in the `BoardRoom` DO (name, issued-at, last-seen).
- `grantEpoch` unchanged on the D1 board row.
- Sliding renewal writes a fresh `fb_grant_<boardId>` cookie on socket upgrade.

### Testability
Unit tests for the renewal path and TTL arithmetic. Browser walk must show: a
grant older than the old 12h ceiling still opens a socket; per-device revoke kills
exactly one device and leaves the others live; `grantEpoch` bump still kills all.

## Key Files

| File | Role |
|------|------|
| `app/lib/board/pairing.ts` | Grant TTL constant; sliding re-mint |
| `app/routes/api/board-ws.ts` | Renewal on upgrade |
| `app/trpc/routes/board.ts` | Per-device revoke |
| `app/routes/boards/_index.tsx` | Paired-devices list + per-device revoke |
| `app/db/schema.ts` | Paired-device records |

## Dependencies
- feat-008 `phone-control` (extends its grant model directly)
- tv-pairing (shares the device-record shape; build after it)

## Security notes
Sliding renewal means a stolen phone keeps access as long as it keeps connecting.
That is the trade decision 3 accepted, and it is why per-device revoke (decision
4) ships in the same feature rather than later — the mitigation and the risk have
to arrive together.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed TV living-room plan |
