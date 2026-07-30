# Feature: Pairing Experience Redesign

_Last updated: 2026-07-29_

**Status: shipped 2026-07-29** — Refero-guided rethink of the pairing +
controller journey (owner chose: scope = pairing + controller, direct build,
extend the hardware aesthetic). Browser-verified PASS (26 assertions + 5
re-checks): [`verifications/2026-07-29.md`](verifications/2026-07-29.md).
Built on feat-014 (QR-first link) and feat-015 (controller mirror).

## Purpose
The three pairing surfaces were built for function; their visuals are three
different products. `/tv` uses off-system `neutral-*` grays and a bare QR;
`/link` is a generic light shadcn card — the sore thumb of the journey; only
the controller speaks the product's design language. This feature brings the
whole scan → login → name → control journey onto the console design system so
the phone reads as the remote control for the same physical object the TV is.

## Reference lock (Refero methodology)

- **Primary reference: the product's own console system** (`console.tsx`,
  `board-frame.tsx`, `flap-tile.tsx` — Vestaboard-measured board, Elektron
  console). Preserve: tonal ladder `#000/#151515/#222226/#0e0e10`, hairline-lip
  depth instead of shadows, 0/2px radii, uppercase micro-labels (0.14–0.2em
  tracking) on labels only, amber **signal-only**, ink-filled plates as the
  action, mono readouts, literal values not theme tokens.
- **Secondary: Refero craft references** (color/motion/craft-details/icons/
  copywriting — MCP unavailable, bundled references used). Borrow only:
  dark-form technical musts (`color-scheme: dark`, `theme-color` meta, dark
  native select, focus-visible bezel rings, 44px targets,
  `touch-action: manipulation`, no mobile autofocus), motion budgets (≤120ms
  key press, 240–360ms pairing state changes, `prefers-reduced-motion`),
  Orientation+Status+Action copy voice.
- **Journey evidence:** device-activation flows (YouTube/Netflix TV pairing) —
  one job per screen, the code is the hero, success says where to look next.
- **Reject:** light shadcn card on `/link`, pills, blur shadows, indigo,
  infinite lamp pulsing (a lit pilot lamp is a *state*, not an animation),
  uppercase instruction text, green as a new success accent (console already
  has amber/red semantics), decorative one-word serif treatments.

## Decision ledger

| Decision | Source | Rule preserved | Why |
|---|---|---|---|
| `/tv` onto CONSOLE ladder; QR on a hairline-lipped plate; code as mono track readout | console.tsx | tonal ladder, literal values | One object, not a web page with a QR pasted on |
| Amber pilot lamp while waiting (static) | console.tsx + motion.md | amber = signal; no infinite loops | Real hardware has a pilot light; pulsing is web decoration |
| `/link` rebuilt as a console surface: wells for inputs, `SegmentTrack` for existing-vs-new | console.tsx | track = mutually-exclusive controls | The radios are why it reads as a web form |
| Success = amber lamp + "The TV is now showing X" + ink "Open the Controller" | copywriting.md | action+object buttons, one line of warmth | Pairing ends where using begins |
| Login stays on the app's light theme | scope decision | — | It is the account system's door (shared with dashboard/admin), not the remote; darkening it moves the sore thumb |
| `color-scheme: dark` + `theme-color` on `/tv`, `/link`, controller | color.md | dark-form technical musts | Address bar/autofill/scrollbars stop flashing white mid-journey |
| Instructions sentence-case body; micro-labels ≥4.5:1 | typography/color | tracking rules, dark-text floors | Uppercase+tracking is a label treatment only |

## When It's Used
- Every unpaired TV visit to `/tv`
- Every QR scan → login → `/link` naming → paired journey
- Every controller session (mirror section polish)

## How It Works
Restyle only — no protocol, route, or state changes. `/tv` swaps `neutral-*`
utilities for CONSOLE tokens and gains the static amber pilot lamp (lit =
waiting, inkMute when unavailable) + the fallback code as a mono track
readout; `/link` trades the shadcn Card for `ConsoleField` (extracted from
`control.tsx` into `console.tsx` and shared), wells for inputs, and a
`SegmentTrack` for existing-vs-new (real radios visually hidden in segment
labels; the reveal is pure `:checked` CSS — `group-has-[[value=new]:checked]` —
so the no-JS submit contract covers showing the right field, verified with
JavaScript disabled end to end); the controller's mirror toggle is 44px and
shares the field. `/tv`, `/link`, and the controller declare
`color-scheme: dark` + `theme-color` via route `meta`. Focus indicators are
amber **outlines**, not `ring-*` — the keys/wells carry inline `box-shadow`
depth, and an inline style beats the ring utility (verification E1 caught the
dead ring; outline composes instead). i18n copy tightened in en+zh.

### Testability
Browser walk verdict doc:
`.brain/features/pairing-experience-redesign/verifications/2026-07-29.md` —
measured rgb values on all three surfaces, the full journey regression
(scan → login → name → TV flips → controller), the no-JS submit + CSS reveal,
a11y spot checks (focus outline, 44px targets, role=status/alert), the
bogus-code no-orphan path, and the intentional light login seam.

## Key Files

| File | Role |
|------|------|
| `app/routes/tv.tsx` | Pairing screen restyle |
| `app/routes/link.tsx` | Console-surface rebuild |
| `app/routes/board/control.tsx` | Mirror section polish |
| `app/components/board/console.tsx` | Shared tokens/chrome (extended, not replaced) |
| `app/locales/{en,zh}/board.json`, `boards.json` | Copy voice |

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-29 | feature | Planned — reference lock + decision ledger from Refero research |
| 2026-07-29 | feature | Shipped — /tv + /link + controller on the console system; E1 focus-ring defect (inline box-shadow vs ring utility) fixed with outline composition, re-verified |
