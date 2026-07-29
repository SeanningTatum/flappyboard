# Feature: Family Grants

_Last updated: 2026-07-29_

**Status: shipped 2026-07-29.** Design approved in plan review round 1 —
`plans/2026-07-28-tv-living-room.html`. Verified by two browser walks:
`verifications/2026-07-28.md` (TTL, revoke isolation, epoch bump) and
`verifications/2026-07-29.md` (the naming delta that closed finding 1).

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

## As built

`DEFAULT_GRANT_TTL_SECONDS` is now `30 * 24 * 60 * 60`. Everything else here
exists to make that number safe.

### The grandfathering rule — the one thing to not get wrong

**A grant with no record is LIVE, not dead.** Every phone already paired when
this ships holds a valid signed grant and has no record in the room, so reading
absence as revocation would have silently un-paired every device in existence on
deploy. Revocation is therefore an explicit **tombstone** keyed by the grant's
nonce, and it is the tombstone — never the absence of a record — that refuses a
grant. The decision lives in `decideTouch` (`app/lib/board/paired-devices.ts`),
away from the storage glue, and is unit-tested on all four combinations.

A tombstone for a nonce the room has no record of gets the 400-day ceiling: a
tombstone that expired early would silently *un-revoke* the device it was written
to exclude, so erring long is the only safe direction.

### Where the renewal happens

On the socket upgrade, in `app/routes/api/board-ws.ts`, as one round trip that
both asks and renews (`touchGrant`). A `Set-Cookie` is appended to the **101**,
which means re-wrapping the response and carrying the `webSocket` across — the
handshake is still an HTTP response, so the browser banks it. If some runtime
ignores it, the grant expires on its original schedule instead of sliding: a
re-pair, not a lockout, which is what makes it safe to do here at all.

The re-mint **reuses the original nonce**. The nonce is the identity per-device
revoke names, so a fresh one per renewal would orphan the record and hand the
device an identity the outstanding revocation no longer covers.

### Cost, stated plainly

`requireBoardAccess` now makes a Durable Object call on every grant-authorised
request. That is the price of per-device revocation: an un-paired phone's cookie
stays cryptographically perfect, because the whole point is that the board's
epoch does *not* move, so something has to ask the room. It fails closed — an
unreachable room refuses the write rather than assuming `live`.

### Records are bounded

`MAX_PAIRED_DEVICES = 64` per board, oldest `lastSeenAt` dropped first. This is a
storage bound, not a policy on how many phones a family may own: a dropped record
costs the device its *row in the owner's list*, never its access, and it
re-creates itself the next time that phone connects.

### Recording never fails a pairing

`pair` records the device after the nonce is spent and the grant is minted, and
swallows a failure with a warning. The phone is paired either way; a failed write
costs the owner the ability to un-pair that one device by name until it next
connects. Refusing a pairing whose credential has already been issued would be
strictly worse.

### The name is captured after pairing, not during

Decision 4 said "name at pairing", but pairing happens inside the `/b/:boardId/c`
loader — a server-side token redemption with no interstitial to type into. So the
name is captured **immediately after**: `claim` returns `deviceName`, and an
unnamed grant phone is offered a dismissible prompt on the controller
(`DeviceNamePrompt` in `control.tsx`). Saving calls `nameDevice`, which names the
caller's own grant record by its nonce — the nonce never crosses the wire, so a
phone can name only itself. `decideName` (`paired-devices.ts`) keeps the touch
invariants: a tombstoned nonce cannot be resurrected by naming it, and an unknown
nonce gets its record created (grandfathered phones can be named without
re-pairing). Owner-side rename remains out of scope.

## As built — files

| File | What landed |
|------|-------------|
| `app/lib/board/paired-devices.ts` | new — records, tombstones, `decideTouch`, `decideName`, `renewRecord`, `pruneDevices`, `overflowVictims` |
| `workers/board-room.ts` | `/grants/record`, `/grants/touch`, `/grants/name`, `/grants/revoke`, `GET /grants` |
| `app/routes/api/board-ws.ts` | revocation check + sliding renewal on upgrade |
| `app/trpc/routes/board.ts` | `pairedDevices`, `revokeDevice`, `nameDevice`; `pair` takes an optional device name; `claim` returns `deviceName` |
| `app/components/boards/board-devices.tsx` | new — the owner's device list, per-row un-pair, un-pair-all-TVs |
| `app/routes/board/control.tsx` | `DeviceNamePrompt` — the post-pairing name offer on the controller |
| `app/models/errors/board.ts` | `PairingRefusal` gains `"revoked"` — the one refusal a token cannot carry |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed TV living-room plan |
| 2026-07-28 | feature | Built. 30-day sliding TTL, per-grant records with tombstone revocation, owner device list on `/boards` |
| 2026-07-29 | feature | Device-name offer wired (verification finding 1 closed): `nameDevice` + `decideName` + controller prompt; shipped after second browser walk PASS |
