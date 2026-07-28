# Feature: Kiosk Display

_Last updated: 2026-07-28_

**Status: in-progress — code complete, the 8h soak and the TV walk outstanding.**
Design approved in plan review round 1 —
`plans/2026-07-28-tv-living-room.html`.

## Purpose
Make `/b/:boardId` survive being left on a wall for months. Three concerns:
staying awake and fullscreen, recovering from a dead socket without human help,
and not burning a static high-contrast grid into an OLED panel.

## Runtime constraint (decision 2)
This runs in the **Samsung TV's built-in browser** — no kiosk stick, no native
Tizen/webOS app. That was chosen against the recommendation in review, and it
sets the ceiling on what this feature can achieve:

- **No autostart.** Someone opens the Internet app after a power cycle. Mitigated
  by setting flappyboard as the startup page; not solvable in software.
- **No kiosk chrome suppression.** Browser chrome may remain visible. Accepted,
  not treated as a failure.
- **Aggressive cookie eviction.** This is the plan's highest operational risk and
  is why `tv-pairing` makes re-pairing two taps on a phone rather than anything
  typed on the TV.
- **Wake Lock likely absent.** The silent-looping-muted-video fallback is written
  as the *primary* path, not the safety net.

## How It Works
- `navigator.wakeLock` feature-detected, video fallback otherwise, and if both
  fail: do nothing. A sleeping TV is not an error worth shouting about.
- `requestFullscreen` rides the gesture handler that already exists at
  `app/routes/board/display.tsx:160` — any keydown, because a TV remote's OK
  button is the only input most of these screens will ever get. That handler was
  written for the sound-unlock gate and is reused rather than duplicated.
- Watchdog: hard-reload once after the socket has been dead past a threshold,
  then back off. Never a reload loop.
- Reconnect spinner over the retained grid while the socket is down (decided in
  review). The last grid stays on screen — a split-flap board holding its last
  message is correct; it just should not pretend to be live.
- Burn-in (decision 5): a few pixels of drift on a slow cycle, plus a scheduled
  idle dim. Drift must never produce a scrollbar — the existing verification
  already asserts `scrollable=false` and that assertion stays.

### Testability
An 8h unattended soak on the real TV. Killing the socket shows the spinner and
triggers exactly one reload. Regression: flap-tile count still exactly 144, grid
24×6, `scrollable=false` **with drift active**.

## Key Files

| File | Role |
|------|------|
| `app/routes/board/display.tsx` | Wake lock, fullscreen, watchdog, drift, dim |
| `app/hooks/use-wake-lock.ts` | Wake Lock + video fallback (unit-tested) |
| `app/components/board/board-offline.tsx` | Reconnect spinner |
| `.brain/recipes/` | Samsung-browser setup recipe |

## Dependencies
- feat-007 `split-flap-board`
- tv-pairing (the display must accept a device grant before it is worth leaving up)

## As built — the numbers the plan left open

The plan pinned the behaviours and left every constant to implementation. They
all live in `app/lib/board/kiosk.ts`, pure and unit-tested (22 tests), so
`display.tsx` holds only wiring:

| Constant | Value | Why this number |
|----------|-------|-----------------|
| `DRIFT_PX` | 3 | Enough that no sub-pixel is lit identically for more than one cycle; far too little to notice from a sofa |
| `DRIFT_INTERVAL_MS` | 4 min | Full circuit in 16 min. Invisible in peripheral vision, frequent enough that no position is held for a meaningful fraction of a day |
| `DIM_START_HOUR` / `DIM_END_HOUR` | 23 / 7 | A hallway board's own schedule |
| `DIM_OPACITY` | 0.35 | Down, not off — still readable by someone walking past at 3am |
| `WATCHDOG_MS` | 2 min | Longer than the socket's own reconnect backoff, so an ordinary three-second blip never triggers a reload |

`isDimHour` wraps midnight, which is the only interesting thing about it: the
naive `hour >= 23 && hour < 7` is false for every hour of the day and the bug is
invisible in daylight. There is a test for exactly that.

Drift is applied as a **transform on a wrapper**, never as layout. A transform
cannot reflow, so the 24×6 geometry, the 144 tiles and the existing
`scrollable=false` assertion all survive with drift active — which was the
plan's stated constraint.

### One gesture, two jobs

Wake-lock is separate, but **fullscreen rides the existing sound-unlock
handler** rather than adding a second listener. Both Web Audio and the Fullscreen
API need a user gesture, and on a wall-mounted TV there may never be another one
after setup — so the first press of the remote's OK button has to spend itself on
both or one of them never happens. A refused `requestFullscreen` is swallowed:
decision 2 accepted that browser chrome may stay visible, and it is not a failure.

### Wake lock is video-first

`navigator.wakeLock` is feature-detected, but the silent looping muted video is
written as the **primary** path because Tizen's browser is the case most likely
to lack the API. The clip is a real 810-byte 16×16 single-frame H.264 MP4 inlined
as a data URI; a test decodes it and asserts the `ftypisom` box, so a truncated
paste fails loudly rather than silently failing to hold the lock. The hook
re-acquires on `visibilitychange → visible` (a lock is released whenever the page
hides — the most-missed part of the API), and if both paths fail it reports
`via: "none"` and does nothing further.

There is no DOM test environment in this repo (`environment: "node"`, no jsdom),
so all behaviour lives in `createWakeLockEngine(host)` with the browser injected —
the same seam `use-board-socket.ts` already establishes. 21 tests.

### Exactly one reload, ever

`shouldReload` is gated on a `reloaded` flag the caller never resets. A reload
loop on a wall-mounted screen is strictly worse than a stale board: the board at
least still shows the last message, whereas a page reloading every two minutes
shows nothing, forever.

### The spinner keeps the grid

`BoardOffline` is a low-opacity scrim over the retained grid, never a cover. A
split-flap board holding its last message is correct behaviour; it just must not
pretend to be live. Reuses the existing `status.*` copy plus one new key
(`status.retained`) in both locales.

## As built — files

| File | What landed |
|------|-------------|
| `app/lib/board/kiosk.ts` | new — `driftOffset`, `isDimHour`/`dimOpacity`, `shouldReload` and their constants (22 tests) |
| `app/hooks/use-wake-lock.ts` | new — Wake Lock with a video-first fallback, testable without a DOM (21 tests) |
| `app/components/board/board-offline.tsx` | new — reconnect scrim over the retained grid (16 tests) |
| `app/routes/board/display.tsx` | wiring: wake lock, fullscreen on the existing gesture, watchdog, drift, dim, spinner; `data-drift` and `data-dimmed` so the soak can assert from the DOM |

## Still outstanding

- The 8h unattended soak on the real TV.
- Regression with drift active: 144 tiles, 24×6, `scrollable=false`.
- The Samsung-browser setup recipe (phase 4) — not yet written.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed TV living-room plan |
| 2026-07-28 | feature | Built. Wake lock, fullscreen on the existing gesture, one-shot watchdog, reconnect scrim, drift + idle dim |
