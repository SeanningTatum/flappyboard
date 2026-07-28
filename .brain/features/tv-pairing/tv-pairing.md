# Feature: TV Pairing (device-code)

_Last updated: 2026-07-28_

**Status: in-progress — code complete, verification outstanding.** Design
approved in plan review round 1 —
`plans/2026-07-28-tv-living-room.html`. Not started; see
[`.brain/features/feature_list.json`](../feature_list.json) for the live status.

## Purpose
Let a TV reach a board without ever holding the owner's login. Today
`app/routes/board/display.tsx` calls `requireSession`, so putting the board on a
TV means typing an email and password with a D-pad — the single largest source of
friction in the product. This feature replaces that with a device-code flow: the
TV shows a short code, the owner approves it from their phone, and the TV gets a
long-lived, revocable device grant scoped to one board.

It is the mirror image of `phone-control`: there, the TV holds the session and
hands authority to a phone. Here the phone holds the session and hands authority
to the TV.

## When It's Used
- First time a TV (or any display) is pointed at flappyboard.
- Again whenever the TV browser evicts the device cookie — the expected failure
  mode given the runtime chosen in decision 2 (Samsung's built-in browser).
- After the owner un-pairs that device.

## How It Works
1. TV opens `/tv`. The route asks the room for a 6-character code (short TTL,
   single-use) and renders it.
2. The TV holds a **WebSocket** to the Durable Object awaiting approval (decided
   in review — not polling). The socket doubles as a liveness signal, letting the
   DO expire an abandoned code.
3. Owner opens `/link` on their phone (already signed in), enters the code, picks
   the board.
4. The DO consumes the code under `blockConcurrencyWhile` — the same single-use
   guarantee already measured for pairing tokens (6 concurrent redemptions →
   `200 401 401 401 401 401`).
5. The DO pushes `approved { boardId, handoff }` down the socket. Because a socket
   frame cannot `Set-Cookie`, the TV then makes one ordinary request to
   `/tv/claim?handoff=…`, which sets `fb_device_<boardId>` (`HttpOnly`) and
   redirects to `/b/:boardId` with the query string stripped.
6. `display.tsx` accepts **session OR device grant**.

### Persistence details
- Code records live in the board's `BoardRoom` Durable Object storage
  (single-use, storage-backed — a replay must fail across a process restart).
- `deviceEpoch` on the D1 board row, a sibling of the existing `grantEpoch`.
  Two epochs on purpose: revoking family controllers must not black out the TV,
  and un-pairing a TV must not log out the family.
- `fb_device_<boardId>` cookie, `HttpOnly`, with the longest `Max-Age` the grant
  TTL allows.

### Testability
Unit tests mirror every existing case in
`app/lib/board/__tests__/pairing.test.ts` onto the new `fbd1` token family.
Browser walk + verification doc required before ship, per
`brain playbook verify`. The decisive test is owner-only and cannot be faked in
CI: **power-cycle the real Samsung TV and confirm the cookie survives.** If it
does not, decision 2 is wrong and the runtime must be revisited.

## Key Files

| File | Role |
|------|------|
| `app/lib/board/pairing.ts` | Third token family `fbd1` + `fb_device_` cookie helpers |
| `app/routes/tv.tsx` | The one URL a TV ever types; code + approval socket |
| `app/routes/tv.claim.ts` | Single-use handoff → `Set-Cookie` + redirect |
| `app/routes/link.tsx` | Owner-side approval |
| `app/trpc/routes/board.ts` | `issueDeviceCode` / `approveDeviceCode` |
| `app/routes/board/display.tsx` | Session-or-device-grant instead of `requireSession` |
| `app/routes/api/board-ws.ts` | Device grant added to the auth matrix |
| `app/db/schema.ts` | `deviceEpoch` on the board row |

## Dependencies
- feat-007 `split-flap-board` (the `BoardRoom` DO and the display route)
- feat-008 `phone-control` (the entire `pairing.ts` HMAC surface is reused, not rebuilt)
- Blocked on issue #1 rate limiting — a short code endpoint needs it (see below)

## Security notes
A 6-character code is ~30 bits. That is safe **only** because it is short-lived,
single-use, and attempt-capped — the RFC 8628 argument. The attempt cap is not
optional: without it this is the weakest authentication path in the product.
Rate limiting (issue #1) is therefore a hard prerequisite, not a nice-to-have.

## Tagged Errors

| Error | Where raised | tRPC code |
|-------|--------------|-----------|
| `PairingTokenError` (extend) | device code verify | UNAUTHORIZED |
| `NotFoundError` | unknown board on approve | NOT_FOUND |

## As built — four decisions the plan left to implementation

### 1. Where an unapproved code lives (the plan's one open question)

**Answered by the owner: a per-code Durable Object instance**, addressed by
`idFromName("code:" + CODE)` — see `deviceCodeRoomName` in
`app/lib/board/device-code.ts`. Neither of the two shapes the plan offered:

- Not a **global codes DO**, which would serialise every pairing in the
  deployment (and every brute-force attempt) through one single-threaded object.
- Not **board-scoped from birth**, which was cheap but inverted the flow — the
  owner would start the pairing and `/tv` would stop being "the one URL a TV ever
  types".

The code *is* the address. The TV's socket and the owner's approval share nothing
but six characters typed across a room, and deriving the instance from those six
characters is what puts them in the same object without a registry.

This is why the code carries real entropy, and it is also why a **watcher secret**
exists: the code decides *which room* you reach, and the watcher decides *whether
you are the one who asked for it*. Without it, anyone who guessed a live code
could hold a socket on that room and be handed somebody else's approval frame.
The watcher is 128 random bits, never rendered on screen, compared in constant
time by the room, and every refusal is an identical 404.

### 2. A fourth token family, not a third

The plan said "add a third token family `fbd1`". As built there are two new
prefixes, `fbd1` (the device grant) and **`fbh1` (the single-use handoff)**.

Reusing `fbp1` for the handoff would have been the smaller diff and was rejected:
an `fbp1` token buys a 30-day controller grant, an `fbh1` token buys a 180-day
device grant, and one prefix for both means a QR photographed off the TV could be
walked into `/tv/claim` and cashed for the longer-lived credential. That is a
privilege escalation across exactly the boundary the two epochs exist to keep
apart. Domain separation is structural (the prefix is inside the MAC), so the fix
was one constant. A 4×4 refusal matrix in `pairing.test.ts` asserts every
off-diagonal pair is refused as `malformed` — before the key is consulted.

### 3. The attempt cap — a deliberate deviation

The plan specified "~5 attempts then the code is burned", counted per code and
per IP in the DO. **A per-code attempt counter cannot work in the shape decision 1
chose, and shipping one would have been security theatre**: a wrong guess resolves
to a *different* room, which is empty, and never touches the real code's storage.
The counter would only ever have seen the guesses that already succeeded.

What replaced it bounds the guesser instead of the guessed:
`DEFAULT_QUOTA["approve-device"]` — a fixed window of **8 approvals/hour per
owner and 16/hour per board**, charged before any code lookup happens. Approving
already requires a signed-in owner nominating a board they own, so the attacker
must hold an account; combined with the 5-minute TTL, a 30-bit code takes on the
order of 10^4 years per board. That is the RFC 8628 argument, honoured through a
different mechanism than the plan named.

### 4. Device grant TTL

**180 days, sliding**, renewed on every socket upgrade. Chosen so that *cookie
eviction, not expiry* is what ends a pairing — the Samsung browser's eviction is
unpredictable, and having the TTL be the shorter of the two would add a scheduled
chore on top of an unpredictable one. Comfortably inside the 400-day `Max-Age`
ceiling browsers clamp to, so the value written is the value honoured.

Renewal **keeps the original nonce**. Drawing a fresh one would orphan the room's
per-device record and hand the device an identity the owner's outstanding revoke
no longer names.

## As built — files

| File | What landed |
|------|-------------|
| `app/lib/board/pairing.ts` | `fbd1` + `fbh1`; `MintDeviceTokenInput`/`VerifyDeviceTokenInput` rename the epoch field to `deviceEpoch` so the two counters cannot be swapped without a compile error; `fb_device_` cookie helpers; `generateNonce` |
| `app/lib/board/device-code.ts` | new — alphabet, generation, normalisation, room naming, record + request/result shapes (50 tests) |
| `workers/board-room.ts` | `/device-code/issue`, `/device-code/watch` (socket), `/device-code/approve`; `DEVICE_CODE_TAG` so a waiting TV can never be sent a board frame nor write one; last-watcher-leaves expires an abandoned code |
| `app/routes/tv.tsx` | the code screen and the approval socket; rotates the code at 2/3 TTL and on wake |
| `app/routes/api/tv-ws.ts` | authorises nothing by design — a conduit to the room the code names |
| `app/routes/tv.claim.ts` | handoff → `Set-Cookie` → 302, query string stripped |
| `app/routes/link.tsx` | owner-side approval, server-action shaped so it works pre-hydration |
| `app/trpc/routes/board.ts` | `issueDeviceCode`, `approveDeviceCode`, `display`, `claimHandoff`; `requireDisplayAccess` |
| `app/routes/board/display.tsx` | session-or-device-grant; a cookie-evicted TV is redirected to `/tv`, never 404 |
| `app/db/schema.ts` | `deviceEpoch` (migration `0003_zippy_rocket_raccoon.sql`) |

## Still outstanding

- **Owner-only, and decisive for decision 2:** power-cycle the real Samsung TV and
  confirm `fb_device_<boardId>` survives. If it does not, the built-in browser is
  not viable and decision 2 must be revisited.
- Browser walk + verification doc per `brain playbook verify`.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed TV living-room plan |
| 2026-07-28 | feature | Built. Per-code DO instance answers the plan's open question; `fbh1` added as a fourth family; per-code attempt cap replaced by a per-owner spend cap (see "As built") |
