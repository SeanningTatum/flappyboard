# Feature: Split-Flap Board

_Last updated: 2026-07-27_

> **Status: in-progress — phases 1 (domain core) and 2 (persistence + realtime room) landed 2026-07-27.** Design comes from the approved plan
> [`plans/2026-07-27-flappyboard-mvp.html`](../../../plans/2026-07-27-flappyboard-mvp.html)
> (approved round 2, 2026-07-27). This doc is filled in as phases 1–3 land.

## Purpose
The board itself: a 6 row × 24 column split-flap display that renders full-screen on a TV,
with a character and a color per cell. It owns the board's data model, the layout compiler that
turns semantic rows into an exact 6×24 grid, the realtime room that keeps every connected client
on the same revision, and the display route.

## When It's Used
- TV opens `/b/:boardId` and subscribes over WebSocket (entry point)
- Any writer (phone controller, LLM agent) pushes a new grid through the Durable Object
- TV wakes from sleep / regains focus → reconnect + resync by revision

## How It Works
`BoardRoom` (a Durable Object, one instance per `boardId`) is the only authoritative writer of
live state. The Worker never holds board state: it validates a `BoardMessage`, compiles it to a
`BoardGrid`, and hands the grid to the DO. The DO fans the grid out to every connected socket
over WebSocket Hibernation and persists a snapshot to D1. Reads that cannot reach the DO fall
back to the latest D1 snapshot so the display always has something to render.

The **layout compiler** is the correctness keystone. Writers produce a `BoardMessage` — up to 6
rows, each an alignment plus a list of `{ text, color }` segments — and the compiler
deterministically upper-cases, maps unsupported characters, word-wraps to 24, applies alignment,
and pads to exactly 6 × 24 cells. The 6×24 invariant is therefore structural, not something a
caller has to get right.

### Persistence details
- D1 `board`: `id`, `ownerId`, `name`, `soundPack`, `muted`, `createdAt` — per-board from day one
  so multiple boards need no migration later (UI ships one board)
- D1 `board_snapshot`: `id`, `boardId`, `revision`, `cells` (JSON), `source`
  (`manual | llm | automation`), `prompt`, `createdAt`
- DO storage holds the live grid + monotonic `revision` + active controller grants
- Write semantics: DO serialises writes; last write wins on a stale revision, and the loser gets
  the current grid echoed back

### Testability
Unit: compiler (every input yields exactly 6×24), repair pass (adversarial fuzz corpus),
`BoardRepository`. Verification: `feature-verifier` browser walk of the display —
idle board, mid-flip, QR overlay, audio-unlock prompt, plus a socket-drop/resync run.
Manual pass required on the actual Samsung TV browser. Thin `e2e/` smoke: display renders 144
tiles.

## Key Files

| File | Role |
|------|------|
| `app/lib/schemas/board.ts` | Effect Schema: `BoardMessage`, `BoardGrid`, palette, charset |
| `app/lib/board/compile.ts` | Pure segments → 6×24 cells compiler |
| `app/lib/board/repair.ts` | Last-resort clamp so a grid always renders |
| `app/lib/board/sfx.ts` | Sound-pack registry, mute state, audio-unlock gate |
| `app/db/schema.ts` | `board`, `board_snapshot` tables |
| `app/repositories/board.ts` | `Effect.Service` repo — boards, snapshots, history |
| `workers/board-room.ts` | `BoardRoom` Durable Object — grid, WS fanout, hibernation |
| `app/services/board-room.ts` | Effect service wrapping the DO stub |
| `app/trpc/routes/board.ts` | `get`, `setMessage`, `history` |
| `app/routes/board/display.tsx` | TV route `/b/:boardId` |
| `app/components/board/*` | `FlapTile`, `BoardGridView`, `QrOverlay`, `SoundUnlockPrompt` |

## Dependencies
- Effect services: `Database`, `CloudflareEnv`, `Logger`
- New CF binding: `BOARD` (Durable Object) + a `migrations` tag in `wrangler.jsonc`, for both the
  default and `preview` env
- Existing `ASSETS` binding serves SFX from `public/sfx/`

## Tagged Errors

| Error | Where raised | tRPC code |
|-------|--------------|-----------|
| `BoardNotFoundError` | repo `getBoard` | NOT_FOUND |
| `BoardStateConflictError` | DO write with a stale revision | CONFLICT |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-27 | feature | Planned from the approved MVP plan (phases 1–3) |
| 2026-07-27 | feature | Phase 1 landed: schema + compiler + repair, 43 unit tests (294 total green). Run note: `runs/2026-07-27-progress.md` |
| 2026-07-27 | feature | Phase 2 landed: D1 tables + `BoardRepository`, `BoardRoom` Durable Object (WS hibernation), `BOARD` binding, protocol module, tRPC `board` router, `/api/board-ws` upgrade route. 417 tests green; two-client sync measured at **1.5ms** against a <300ms bar |
| 2026-07-27 | bugfix | R2 removed from the global Effect runtime — a merged layer builds every member, so the missing `BUCKET` binding was failing `AuthApi` construction and 500ing **every** request |

## Phase 1 — implemented behaviour (2026-07-27)

Two layers, one invariant. `BoardMessage` is the loose semantic input; `BoardGrid` is the strict
6×24 output; `compileMessage` is the only bridge, so no caller can produce an invalid board.

Rules the compiler settled on, all covered by tests:

- **Charset** — `" ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$()-+&=;:'\"%,.?/°"`. Text is NFKD-folded
  (so `Café` → `CAFE`), uppercased, then near-misses are aliased (`_`→`-`, `*`→`+`, `[`→`(`,
  `|`→`/`, smart quotes → straight, en/em dash → `-`, newline/tab → space). Anything left over is
  dropped and counted.
- **`black` is the off/background tile**, not a paint colour. A blank cell is always
  `{ char: " ", color: "black" }`.
- **Colour applies to glyphs. Only a segment that is *entirely* spaces produces coloured tiles.**
  (Sharpened 2026-07-27 — see below for what it replaced.) So `{ text: "HAPPY FRIDAY!", color:
  "green" }` is green letters with an **unlit** gap between the words, and `{ text: "      ", color:
  "violet" }` is a violet bar. Everything else is a separator space: it normalises to the blank
  cell and collapses at a wrap boundary. A lit gap inside coloured text is still sayable — it is its
  own all-space segment — and that is exactly the shape a per-cell paint round-trips into, which is
  what keeps borders, bars and `cell-paint.ts` working.
  - **Superseded:** the rule used to be the flatter "a space with no colour of its own is a
    separator; a space with a colour is a tile", whatever else was in the segment. It cost 17 stray
    lit tiles across 15 boards in the 2026-07-27 LLM eval (`HAPPY#FRIDAY!`), because a writer
    colouring a phrase means *coloured letters*. A real board's inter-word gap is an unlit card.
  - **Wrap consequence, verified:** a coloured segment's interior spaces are now `gap` tokens, so a
    long coloured segment word-wraps between its words instead of being carried as one atomic
    `word` token and hard-split at column 24 — i.e. it now wraps exactly as the same text in white
    always did. Asserted in `compile.test.ts`.
  - **Recovery consequence:** `gridToMessage` splits a *pigment* colour run at its space boundaries
    (`HI THERE` painted red → `HI` / `" "` / `THERE`, all red) so a painted grid still round-trips
    to an identical grid. White runs are not split, or a `spread` row's gap would come back as one
    segment per column.
  - **Editor consequence:** `stripRowPadding` now strips the last segment's trailing whitespace in
    *any* colour — those cells are no longer lit, but they are still cells and would push a
    `spread` row's value off the right edge. An all-space pigment segment is exempt: it is a bar,
    not padding.
- **Wrapping** is greedy to 24 columns; a word longer than the board is hard-split rather than
  dropped. Wrapped continuation lines consume subsequent board rows.
- **An empty semantic row still occupies a board row**, so vertical spacing is expressible.
- **Alignment** pads with blank cells; `center` puts the odd cell on the right.
- **`compileMessage` reports loss** (`droppedLines`, `droppedChars`, `truncated`) — that's the
  signal behind the planned "trimmed to fit" hint, not an error.
- **`repairMessage` is total** — never throws, coerces bare strings, row shorthand, scalar text,
  invented colours/alignments, over-long text and over-long arrays. `decodeOrRepair` decodes first
  and only repairs on failure, so schema defaults don't count as a repair.

## Phase 2 — implemented behaviour (2026-07-27)

One live board = one `BoardRoom` Durable Object, and it is the **only** writer of live state.
The Worker never holds board state.

- **Hibernation, not a socket list.** Sockets are accepted with `ctx.acceptWebSocket` and handled
  via `webSocketMessage` / `webSocketClose` / `webSocketError` class methods, fanning out through
  `ctx.getWebSockets()`. An idle board costs nothing. Do not "simplify" this into an
  `addEventListener` loop with an instance field — that defeats the entire point.
- **All meaning lives in `app/lib/board/protocol.ts`** (pure, 86 tests) so the protocol is testable
  without miniflare and there is exactly one compile site for message → grid. The DO owns only
  sockets, storage and D1.
- **`baseRevision` is advisory.** The room is last-write-wins: a stale, absent, negative or
  non-numeric `baseRevision` normalises to 0, the write still applies, `revision` always
  increments, and the loser learns the truth from the echoed state.
- **Write order is live-first, durable-second:** DO storage → broadcast → D1 snapshot. A failed
  snapshot logs and sends `error/persist_failed` to the originating socket only; it never loses the
  live update or crashes the room.
- **`GET /api/board-ws` is the browser's only door in** (tRPC can't carry an upgrade). It
  authenticates, checks ownership, and returns the DO's `101` Response untouched.
- **Ownership is non-enumerable** — someone else's board is `NotFoundError`/404, never 403, in both
  the tRPC routes and the socket route.
- **WebSocket writes bypass tRPC entirely**, so anything that must happen per-write belongs in the
  DO. That is why the DO — not just `BoardRepository` — bumps `board.revision`.

## Flap travel — the board actually travels (2026-07-27, supersedes the Phase 3 flip)

A real split-flap position is a drum of hinged cards that only moves **forward**. Showing `Z`
when currently showing `A` means flipping through every character between them, so travel time is
proportional to distance and the stagger is **emergent physics, not decoration**. The earlier
`(row + col) * 14ms` stagger and its `FLAP_STAGGER_MS`/`FLAP_DURATION_MS` constants are **gone**.

| | |
|---|---|
| `FLAP_STEP_MS` | **72** (57-glyph drum ⇒ worst travel 56 flaps; a 3–5s window implies 54–89ms/flap, and 72 keeps each glyph on screen >4 frames at 60Hz) |
| Worst case | **4160ms** (55 × 72 + 200ms landing flip) |
| Best case | **200ms** — a one-flap change (`A`→`B`) costs exactly what the old animation did |
| Measured live | first motion **19ms**, last tile moving **3950ms**, total **≈4.2s** |
| Long-travel tile | passed through **27 distinct glyphs**, one per 72ms |

**Colour-only changes flutter, they don't revolve.** Repainting a row red would otherwise cost the
same ~4s as rewriting the board *and* would scramble text nobody asked to change, so a
colour-only cell does a 5-flap flutter (488ms) landing back on its own glyph. Both behaviours are
tested.

### Why it doesn't melt a TV
144 tiles stepping every 72ms is thousands of potential updates per second, so:

- **One `requestAnimationFrame` loop** for the whole board (`useFlapAnimation` in
  `board-grid-view.tsx`). All tiles share one start timestamp and derive their own step index from
  elapsed time — no per-tile timers, nothing to clear, `O(moving)` per frame.
- **React never touches a face.** `FlapTile` freezes its face subtree in a `useMemo` keyed on a
  ref-stable first render; the loop finds faces via `data-flap-face` and writes
  `textContent`/`transform`/`opacity` directly, and only on step boundaries (~3 frames in 4 it just
  compares integers). React owns `data-char`/`data-color` on the tile root — the **target**,
  deliberately not what's on screen.
- **The deliberate trade:** intermediate flaps are instant cuts (one `textContent` + one alternating
  `rotateX(-34deg)`), not interpolated. Interpolating meant either ~4,300 CSS animation starts/sec
  or ~8,600 transform writes/sec. Only the **landing** gets the real two-face hinge flip.
- **Measured** at 1280×720: mean frame **16.60ms**, p95 **18.60ms**, worst long frame **31.9ms**,
  **zero** frames over 33ms across 262 samples.

### The clatter
`tick(movingCells)` runs from the same loop. `interval = 320 / sqrt(moving)` clamped to
**[45ms, 260ms]** — a cap of ~22 clacks/sec against the ~2,000/sec that one-clack-per-tile-per-flap
would demand. `sqrt` spends the dynamic range on the tail, where the ear actually hears it thin
out. Pool raised 4 → **6** (the soft pack's 130ms sample spans ~3 slots at the cap, and cut tails
are what make a rattle sound like a metronome). Pitch ±8% and level −18%…0 per clack from the
seeded PRNG, so the WAVs did **not** need regenerating — checksums unchanged.

Measured on a 144-tile change: **54 clacks over 3616ms**, gaps 49–116ms, thinning
**17 → 15 → 14 → 8 → 0 per second**, 52/54 distinct rate+volume combinations, no allocation past
the pool. **Muted: 120 tiles moving, 0 plays.** Not-yet-unlocked: 0 plays, animation still runs.

### Mid-travel retarget
The plan is computed against what the **DOM is showing**, never the previous React grid. A tile
three glyphs into `A→Z` reports `D` and continues forward from `D`; a target now behind it wraps
rather than reversing. Tiles no longer wanted are settled flat. Measured after retargeting 1.2s
into a full-board travel: **0 glyph mismatches, 0 stranded tiles**.

`prefers-reduced-motion`: instant swap, no travel, no sound — verified by assertion.

### Phase 2 verification (live, driver deleted afterwards)

Drove the running app with two clients on one board plus a third on a second board:

| Check | Result |
|---|---|
| Write on one client reaches the other | **1.5ms** (bar: <300ms) |
| Compiled text + per-segment colour survive the round trip | `SYNC CHECK` / `PHASE TWO`, row0 yellow, row1 green |
| Board isolation | board B saw 1 own-state event, **0 contaminated** |
| Stale `baseRevision` | still applies, revision advanced 2 → 4 |
| Unauthenticated socket / plain GET / unknown board | refused / 426 / refused |
| D1 after 4 socket writes | `board.revision = 4`, snapshots 1–4 present, second board still 0 |

The isolation check failed on its first run — board B's *own* connect-state arrived after the
buffer clear. Counting events was the wrong assertion; asserting on content is what actually
proves isolation.
