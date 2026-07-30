# Feature: Controller Board Mirror

_Last updated: 2026-07-29_

**Status: shipped 2026-07-29.** Browser-verified PASS (11 assertions, walk run
3×): [`verifications/2026-07-29.md`](verifications/2026-07-29.md). Extends
feat-008 phone-control.

## Purpose
The person controlling the board from their phone should not have to look at the
TV to see what the board says. The controller page (`/b/:boardId/c`) already
holds the live board over its socket — it just never renders it. This feature
renders that grid inline: a collapsible, silent, container-sized mirror at the
top of the controller.

## When It's Used
- Phone paired to a board opens `/b/:boardId/c` → mirror visible under the header
- Any write (from this phone, another phone, the LLM agent) flips the mirror live
- Operator collapses the mirror to reclaim editor space; state is session-local

## How It Works
- `app/components/board/board-grid-view.tsx` gains an optional `variant` prop.
  `"display"` (default) is byte-identical to today's TV sizing. `"inline"` sizes
  the field to its container (`width: 100%`, `aspect-ratio: 24/12`, glyph size
  from container width via `container-type: inline-size` + `cqw`). The flap
  animation loop is sizing-agnostic and unchanged; Tizen never sees the inline
  path.
- `app/routes/board/control.tsx` renders `<BoardGridView variant="inline"
  grid={live.grid} />` in a collapsible section under the sticky header, default
  expanded, with no `onMotion` (silent — the TV makes the noise).
  `data-testid="control-board-mirror"` for the verifier.

### Testability
Browser walk verdict doc:
[`verifications/2026-07-29.md`](verifications/2026-07-29.md) — PASS, 11
assertions: mirror open by default with exactly 144 tiles; a write from the
same phone updates the mirror's `board-grid` aria-label live (no reload,
motion settles to `data-flap-moving="0"`); collapse toggle removes the grid
from the DOM and restores it; the TV display route is byte-unaffected
(144 tiles in `board-frame`, zero `board-mirror` elements); reduced-motion
emulation still updates instantly and silently.

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-29 | feature | Planned from owner-approved session plan |
| 2026-07-29 | feature | Shipped — inline, silent, collapsible live mirror on the controller |

## Key Files

| File | Role |
|------|------|
| `app/components/board/board-grid-view.tsx` | `variant` prop (display/inline sizing) |
| `app/routes/board/control.tsx` | Collapsible mirror section |
| `app/locales/{en,zh}/board.json` | Toggle copy |

## Dependencies
- feat-008 phone-control (`useBoardSocket` live grid on the controller)
- feat-007 split-flap-board (`BoardGridView`, flap animation loop)

