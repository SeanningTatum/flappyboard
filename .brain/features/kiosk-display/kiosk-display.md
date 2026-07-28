# Feature: Kiosk Display

_Last updated: 2026-07-28_

**Status: planned.** Design approved in plan review round 1 —
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

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-28 | feature | Registered as planned from the reviewed TV living-room plan |
