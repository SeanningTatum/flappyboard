# Feature: Brand System

_Last updated: 2026-07-31_

## Purpose
Phase 1 of a four-phase redesign approved in review round 1 (artifact: `plans/2026-07-31-brand-ia-redesign.html`; the full plan text also lives at `/Users/sean/.claude/plans/i-want-us-to-optimized-lightning.md`). The repo has two design systems: `app/app.css` is stock shadcn "neutral" unmodified, while `flap-tile.tsx` / `board-frame.tsx` / `console.tsx` carry a researched hardware language entirely in hardcoded hex, outside the token contract. This phase makes the hardware language the contract.

## When It's Used
- Every route rendered by the app consumes the global token contract in `app/app.css` (radius, focus ring, semantic colors)
- The four console routes (`/b/:boardId`, `/b/:boardId/c`, `/tv`, `/link`) additionally opt into the `[data-surface="hardware"]` scoped override
- Design-system regression is checked on every future UI change via `bun run design:audit` and the `feature-verifier` browser walk

## How It Works
Global semantic tokens in `app/app.css` are retuned off the object rather than off shadcn defaults: radius drops to 2px, amber (`#ffcc00`) is promoted to a new `--signal` token (never `--primary` — it is a state signal, not an action fill), and the 8 flap pigments measured off a real Vestaboard with PIL are mirrored into the contract as `--flap-*` custom properties, checked against `TILE_COLORS` by a parity test so the hardcoded hex in `flap-tile.tsx` and the token contract cannot drift apart. Two self-hosted OFL typefaces (Archivo for display/labels, IBM Plex Mono for codes/readouts) replace the runtime Google Fonts `<link>` in `root.tsx`, with static font-weight cuts served alongside variable cuts because the Samsung Tizen TV panel is Chromium 56 (variable fonts need 62+). The board's own glyph rendering is pinned to `--font-flap` (mapped to Inter) behind a shared `FLAP_GLYPH_CLASS`, so a change to `--font-sans` cannot leak into the frozen board render. The app-wide focus ring is fixed by giving `--ring` two values — a contrast-safe darkened amber in `:root`/light surfaces, and the full-brightness lamp color in `.dark` and the hardware scope — closing the ~1.6:1-on-white defect. `console.tsx`'s exports keep identical names and shapes throughout, since phases 2 and 3 depend on them.

### Persistence details
- No new storage — this phase is CSS custom properties, font assets under `app/assets/fonts/`, and `console.tsx` internals repointed at `var(--hw-*)`
- No schema or envelope changes
- No write semantics changes
- No migration/corruption surface

### Testability
- Parity test asserting `TILE_COLORS` (the hardcoded flap pigments) match the new `--flap-*` custom properties, so the token contract and the frozen board glyph rendering cannot silently diverge
- `bun run design:audit` gate: must stop emitting the `fontFamilies < 2` craft note once both self-hosted typefaces are wired
- Keyboard walk across every route (`/b/:boardId`, `/b/:boardId/c`, `/tv`, `/link`, and the app's light-theme routes) verified by **screenshot**, not computed style — jsdom does not resolve custom properties, so unit tests must never assert on computed colors
- `feature-verifier` browser walk expected before ship, per the standard `/verify-done` gate
- Golden board screenshots under `.brain/features/split-flap-board/screenshots/` must still match — board render frozen

## Key Files

| File | Role |
|------|------|
| `app/app.css` | Global semantic token contract — radius, `--signal`, `--ring`, `--flap-*`, `[data-surface="hardware"]` scope |
| `app/root.tsx` | Font loading — replaces the runtime Google Fonts `<link>` with self-hosted Archivo + IBM Plex Mono |
| `app/assets/fonts/` | Self-hosted OFL font files (Archivo, IBM Plex Mono; static + variable cuts) |
| `app/components/flap-tile.tsx` | Frozen board glyph rendering — repointed to `--font-flap` / `FLAP_GLYPH_CLASS`, colors parity-tested against `--flap-*` |
| `app/components/board-frame.tsx` | Board chassis — hardcoded hex candidate for tokenization |
| `app/components/console.tsx` | Shared console chrome consumed by phases 2/3 — repointed at `var(--hw-*)`, export names/shapes unchanged |
| `app/routes/tv.tsx` | TV pairing route — static font cut required (Tizen/Chromium 56) |
| `app/routes/link.tsx` | Pairing route — hardcoded workaround at `link.tsx:346-354` slated for deletion once the focus-ring fix lands |
| `app/components/sound-unlock-prompt.tsx` | Hardcoded workaround at `sound-unlock-prompt.tsx:48` slated for deletion once the focus-ring fix lands |
| `scripts/design-audit.ts` | Design-system gate consumed by `bun run design:audit` |

## Dependencies
- `feat-007` Split-Flap Board — board render is the frozen reference this phase must not visually change
- `feat-008` Phone Control — controller surface adopts the hardware scope
- `feat-016` Pairing Experience Redesign — established the console tonal-ladder language this phase tokenizes
- No new Effect services, repositories, or CF bindings — this is a CSS/asset-only phase

## Tagged Errors
None — this phase does not touch routes, repositories, or services that raise tagged errors.

## Known traps
- `--radius-sm: calc(var(--radius) - 4px)` at `app/app.css:21` goes **negative** at a 2px radius, which is invalid CSS, so the declaration is silently dropped and `.rounded-sm` stops applying across avatar/badge/checkbox/dropdown-menu/select. Needs `max(0px, calc(...))`.
- `--ring` amber fails contrast on light surfaces (`#ffcc00` on white ≈ 1.6:1 against a 3:1 floor) — needs two values, darkened in `:root`, the real lamp in `.dark` and the hardware scope.
- `flap-tile.tsx:327` renders the glyph with `font-sans`, so changing `--font-sans` would change the frozen board. Needs `--font-flap` pinned to Inter behind a shared `FLAP_GLYPH_CLASS`.
- jsdom does not resolve custom properties — never assert on computed colors in tests.
- Variable fonts need Chromium 62+; a 2017 Samsung Tizen panel is Chromium 56, and `tv.tsx:296` renders the device code in `font-mono` on that panel. Static cuts on the TV path.

## Design research
Reference lock — **extends** the existing hardware lock rather than re-opening it. Named references, all previously recorded in this repo when the Refero MCP was available:
- **Elektron** — primary. Tonal ladder (surface layering, sharp corners), amber as a state signal never an action fill. Recorded in `.brain/features/phone-control/runs/2026-07-27-progress.md`.
- **Oxide Computer** — elevation via tonal shift + hairlines, never drop shadows. Same source.
- **teenage engineering** — industrial gray as stage, hairline dividers as structure. Same source.
- **Vestaboard** — the category and price anchor (~$3k split-flap home object); its pigments were measured with PIL, recorded in `.brain/features/split-flap-board/runs/2026-07-27-progress.md`.

**Degradation, stated plainly:** `REFERO_MCP_TOKEN` is unset by owner decision, so the Refero MCP tools declared in `.mcp.json` are unavailable. Per `.brain/rules/frontend.md` the fallback is the `refero-design` skill's bundled craft references plus tier-1 `ui-ux-pro-max`. No live Refero research was performed for this phase.

Decision ledger (one row per decision → concrete choice → which reference it traces to):

| Decision | Choice | Traces to |
|---|---|---|
| layout | Three surface levels max; tonal steps, never nested cards | Elektron / Oxide |
| type | Archivo (display/labels) + IBM Plex Mono (codes/readouts), both SIL OFL 1.1, self-hosted | closes `console.tsx`'s own "no condensed face ships with the app" comment |
| color | Global contract retuned off the object; amber `#ffcc00` becomes `--signal`, never `--primary` | Elektron — amber is state, never an action surface |
| radius | `--radius: 0.125rem` (2px) | `console.tsx` documents the object as 0px panels / 2px wells |
| elevation | Hairline + 1px lip, no blur | Oxide — elevation via tonal shift and hairlines |
| motion | Unchanged this phase | — |
| imagery | None; the product renders itself | Vestaboard — the object is the hero |

## Acceptance criteria
- Golden board screenshots under `.brain/features/split-flap-board/screenshots/` still match (board render frozen)
- `bun run design:audit` stops emitting the `fontFamilies < 2` craft note
- Keyboard walk shows a visible focus ring on every route, verified by screenshot not computed style
- `/admin/kitchen-sink` renders every shadcn primitive with no dropped radius
- `console.tsx` exports keep identical names and shapes (it is shared by phases 2 and 3)

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-31 | feature | Feature scoped and started: token-contract phase 1 of the brand/IA/UX redesign. Implementation not yet begun. |
