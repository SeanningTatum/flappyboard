# Feature: TV Pairing (device-code)

_Last updated: 2026-07-28_

**Status: planned.** Design approved in plan review round 1 —
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

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed TV living-room plan |
