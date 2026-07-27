# Feature: Phone Control

_Last updated: 2026-07-27_

> **Status: in-progress — implemented and gap-closed 2026-07-27, pending verification.** Design comes from the approved plan
> [`plans/2026-07-27-flappyboard-mvp.html`](../../../plans/2026-07-27-flappyboard-mvp.html)
> (approved round 2, 2026-07-27). Phase 4.

## Purpose
Turns any phone in the room into the board's remote control by scanning a QR code on the TV —
no login on the phone. Owns pairing, the manual board editor, history re-flip, and the board's
sound settings.

## When It's Used
- User scans the QR overlay on the TV → lands on `/b/:boardId/c` with a pairing token
- User types rows, picks colors, hits Send → board flips
- User taps a past snapshot in the history strip → board re-flips to it
- User changes sound pack or mutes → setting pushes to the TV over the same socket

## How It Works
The display renders a QR encoding a **short-TTL, single-use, HMAC-signed pairing token** (signed
with `BETTER_AUTH_SECRET`), and rotates it. `board.pair` verifies signature, expiry and
single-use, then issues a scoped controller grant as a cookie that the Durable Object recognises;
the grant is revocable from the TV. The phone then writes through the DO exactly like any other
writer — commands carry the revision they were based on.

Treat everything on the TV as public: the board URL alone grants nothing, which is why the token
exists.

### Persistence details
- Controller grants live in DO storage (survive eviction, revocable, scoped to one `boardId`)
- Pairing tokens are stateless and signed — only their single-use marker is stored in the DO
- `soundPack` / `muted` live on the D1 `board` row so the TV picks them up on reconnect

### Testability
Unit: pairing token sign/verify — expiry, tamper and replay all rejected; sound-pack registry.
Verification: `feature-verifier` golden path (scan → pair → type → board flips) plus one error
path (expired token → "rescan the QR", no state change), and a mute-from-phone run. Thin `e2e/`
smoke: an unpaired controller is refused.

## Key Files

| File | Role |
|------|------|
| `app/lib/board/pairing.ts` | HMAC sign/verify for the pairing token |
| `app/trpc/routes/board.ts` | `pair`, `setMessage`, `history` |
| `app/routes/board/control.tsx` | Phone route `/b/:boardId/c` |
| `app/components/board/SoundPackPicker.tsx` | Sound pack + mute control |
| `app/locales/en/board.json` | i18n namespace (register in `app/i18n/i18n.d.ts`) |

## Dependencies
- `[[split-flap-board]]` — the grid model, compiler and DO
- Effect services: `CloudflareEnv` (for `BETTER_AUTH_SECRET`), `Session`, `Database`
- No new CF bindings

## Tagged Errors

| Error | Where raised | tRPC code |
|-------|--------------|-----------|
| `PairingTokenInvalidError` | `board.pair` — bad signature, expired, replayed | UNAUTHORIZED |
| `BoardNotFoundError` | repo `getBoard` | NOT_FOUND |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-27 | feature | Planned from the approved MVP plan (phase 4) |
| 2026-07-27 | feature | Implemented: pairing tokens + controller grants, `/b/:boardId/c`, message editor with live compiled preview, sound-pack picker, mute, history re-flip. 30 pairing tests |
| 2026-07-27 | bugfix | Single-use pairing moved from the Workers Cache API (per-colo, evictable, **a no-op under `wrangler dev`** — so replay protection was effectively absent locally) into the board's Durable Object, where `blockConcurrencyWhile` makes check-and-set atomic |
| 2026-07-27 | feature | `updateSettings` now reaches the TV — the room broadcasts a settings frame at the **same revision**, which is what makes the plan's "mute from the phone silences the next flip" criterion achievable |
| 2026-07-27 | feature | `/api/board-ws` accepts a controller grant, so a grant-only phone gets the live board instead of the socket being disabled |
| 2026-07-27 | bugfix | The display re-mints the QR token every ~40s; previously a TV left on the wall for 3 minutes showed a dead code |

## Implemented behaviour (2026-07-27)

### The security model, in one place
Two tokens, both HMAC-SHA256 over `crypto.subtle` keyed with `BETTER_AUTH_SECRET`:

- **Pairing token** — minted by the display, printed as the QR, ~120s, single-use.
- **Controller grant** — issued on redemption, `HttpOnly` per-board cookie, ~12h.

Properties worth not breaking:

- **The signed message is `prefix|boardId.length|boardId|payload`.** The prefix gives domain separation (a grant presented as a pairing token fails `malformed` before the key is consulted); the board id is a MAC *audience*, so a board-A token fails to verify for board B with no post-hoc id comparison to forget; length framing keeps the encoding injective.
- **Verify order is structure → signature → claims** — nothing in the payload is trusted, not even to say "expired", until the MAC matches.
- **`timingSafeEqual`** accumulates over the full length. An early-return compare would turn forging a 32-byte MAC from 2^256 work into ~32×256 work.
- **Single-use lives in the Durable Object.** One object per board, single-threaded, check-and-set under `blockConcurrencyWhile`. Proven: 6 concurrent redemptions of one token → `200 401 401 401 401 401`; replay after a full dev-server restart still refused.
- **A grant is not a session.** `create`/`list`/`get` remain owner-only; only `setMessage`/`updateSettings`/`history` accept one.
- **Non-enumerability**: which failure you get depends only on what the caller *sent*. No grant + no session ⇒ 404 (decided before any DB read); a grant cookie that doesn't verify ⇒ 401. Anyone can fabricate that cookie for any id, so the branch leaks nothing.
- **`Path=/` on the cookie is required** — writes go to `/api/trpc`, so a board-scoped path would starve every mutation.

### Editor simplifications (v1)
One segment per row (text + colour + align). Trailing whitespace is stripped and no padding is emitted. The preview runs the real `compileMessage` as a static miniature rather than reusing `FlapTile` (which would run a flip × 144 tiles per keystroke). History entries are text, not 144-tile thumbnails.

> **Superseded 2026-07-27 (twice).** The v1 editor was one segment per row; it is now **type-first** — six bare inputs with no controls, the grid directly below as the colouring surface, and per-row colour/alignment collapsed into one plate scoped to the focused row (~40 controls → ~13). Row-paint handles and drag-to-paint landed with it.
>
> The padding rationale above also changed: it used to be *"a coloured space renders as a lit tile"*. The rule is now **colour applies to glyphs — only an all-space segment produces coloured tiles**, so a coloured word's inter-word gaps are unlit. `stripRowPadding` therefore strips a trailing run in *any* colour (those cells are no longer lit but are still cells, and would push a `spread` row's value off the right edge), with an all-space pigment segment exempt because that is a bar, not padding. See `../split-flap-board/split-flap-board.md`.

### Known limits
- The nonce ledger is per-board-DO and durable, but pruning is bounded to 256 keys per spend — fine for a ~120s token, and deliberately bounded so one request can't stall the object's input gate.
- `gridToMessage` reports `align: "right"` for an all-blank row. Unobservable (`padLine([], anything)` is the same blank row) and recorded in a test rather than left implicit.
- The mute→silence link is proven up to frame delivery at an unchanged revision; the final `setMuted` hop is Web Audio and not observable headlessly.
