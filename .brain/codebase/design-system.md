# Design System — flappyboard

> **The board is the brand.** This document was re-opened and rewritten on 2026-07-31. The previous direction (Cursor + Linear, restrained/technical, aimed at "engineers evaluating whether to fork the repo") was inherited from the starter template and was aimed at the wrong reader. flappyboard is a ~$3k-feeling split-flap object for a living room, driven from a phone. Approved in review round 1 — `plans/2026-07-31-brand-ia-redesign.html`.

## Direction

The repo used to carry two design systems and only one of them was any good.

`app/app.css` was stock shadcn "neutral", unmodified. Meanwhile `flap-tile.tsx`, `board-frame.tsx` and `console.tsx` carried a researched physical language — a tonal ladder, hairlines instead of blurs, 1px lips instead of shadows, eight pigments measured off a real Vestaboard with PIL — entirely in hardcoded hex, unreachable by any other surface.

**The work was extraction, not invention.** The board's language is now the token contract. Nothing here was made up; it was promoted.

| Pillar | What it means concretely |
|---|---|
| **Physical** | Depth is a tonal step plus a hairline plus a 1px lip. Never a blur, never a drop shadow imitating a photograph. |
| **Tight** | `--radius: 0.125rem`. The object is 0px on panels and 2px on wells; a pill would be a lie. |
| **Ink, not black** | `--foreground` is the unlit flap (`#1f1f22`), `--background` is warm paper. Nothing printed is ever pure. |
| **One signal** | Amber is a *state*. It is `--signal`, never `--primary`, and never an action fill. |
| **The product is the hero** | We render a working split-flap board at 60fps. Any surface that needs to impress should show it rather than describe it. |

**The register to avoid** is skeuomorphic costume — fake screws, brushed-metal photo textures, bevels imitating a photograph. The object earns its physicality from gradients and lips. `.brain/recipes/add-premium-surface.md` step 3: never build the metaphor literally.

## Two surfaces, one contract

| | App surface | Hardware surface |
|---|---|---|
| **Where** | `/`, `/login`, `/sign-up`, `/boards`, `/admin/*` | `/b/:boardId`, `/b/:boardId/c`, `/tv`, `/link` |
| **Themes** | Light + dark, `next-themes`, `defaultTheme="system"` | Dark always — a sheet of painted metal has no light mode |
| **Defined in** | `app/app.css` `:root` / `.dark` | `app/routes/board/hardware-theme.css`, `[data-surface="hardware"]` |

The hardware surface is a **scoped token override** — the same variable names with different values, per "Scoped design systems" in [`../rules/frontend.md`](../rules/frontend.md). Because the names are the shadcn names, every primitive rendered inside the scope re-themes for free with zero component edits.

Two things about that scope are load-bearing and easy to break:

1. It is declared **twice** — `[data-surface="hardware"]` and `.dark [data-surface="hardware"]`, identical values. `ConsoleField` sets `className="dark"` on the same `<main>` that carries the attribute; there the two selectors tie on specificity and source order would decide it silently.
2. `console.tsx`'s exported `CONSOLE` object reads the scope through `var(--hw-*, <literal>)`. **The fallbacks are not decoration.** The fixed backdrop `<div>` in `ConsoleField` renders as a *sibling* of the scoped `<main>`, and jsdom does not resolve custom properties at all. In both cases the fallback is what paints.

## Tokens

Semantic names only. Full values in `app/app.css`; the ones that are new or easy to misuse:

| Token | Light | Dark | Notes |
|---|---|---|---|
| `--signal` | `#8f6a00` | `#ffcc00` | The pilot lamp. **State only, never an action fill.** |
| `--ring` | → `--signal` | → `--signal` | Two values on purpose — see below |
| `--text-heading` / `--text-body` / `--text-body-subtle` | ink ladder | ink ladder | Closes drift where `frontend.md` documented tokens that did not exist |
| `--flap-red` … `--flap-unlit` | — | — | **Theme-invariant**, declared once, never re-declared |
| `--hw-*` | — | scope only | Material recipes with no shadcn equivalent |
| `--font-sans` | Archivo | | + explicit CJK fallback |
| `--font-mono` | IBM Plex Mono | | Ships on the TV path |
| `--font-flap` | Inter (subset) | | **Board only.** Never use `font-flap` outside a flap-shaped object |

### Why amber carries two values

`#ffcc00` on white is **1.51:1**. The WCAG 2.2 floor for a focus indicator (SC 1.4.11) is 3:1. So the lamp itself only survives on dark surfaces; light surfaces get a deep amber at 4.72:1 on paper. This is the trap hiding inside "the brand owns the focus color" — a single-value brand accent would have shipped an invisible focus ring for the second time.

### Why the pigments are not `--chart-*`

There are eight, not five; `--chart-*` is already consumed by `ui/chart.tsx` and recharts; and chart tokens legitimately flip between themes — which is exactly what a pigment must never do. A red flap is red on a television in a lit room whatever the phone's theme is. They are mirrored from `TILE_COLORS` and pinned to it by `app/components/board/__tests__/flap-pigment-parity.test.ts`.

## Type

Two real faces, both **SIL OFL 1.1**, both self-hosted from `app/assets/fonts/` (Vite content-hashes them; `public/_headers` caches them immutably). There is no runtime Google Fonts request.

- **Archivo** — display and UI. American gothic news/wood-type roots: the register of a split-flap unit, not of a dashboard.
- **IBM Plex Mono** — codes, readouts, tech labels. Engineering-instrument provenance rather than IDE provenance, with a slashed zero and an unambiguous `1`/`l`. It renders the six-character device code someone is transcribing off a television.

**Every cut is static, deliberately.** A variable font needs Chromium 62+; a 2017 Samsung Tizen panel is Chromium 56, and both `/tv` and `/b/:boardId` render on exactly that hardware. A silently-ignored `wdth` axis there would paint every glyph at full width against metrics tuned for a condensed one, on the one device nobody can debug remotely.

`font-display: block` on anything on the TV path (mono and flap); `swap` on Archivo.

| Role | Class |
|---|---|
| Display | `text-5xl sm:text-6xl font-semibold tracking-tight` |
| H1 / H2 | `text-3xl` / `text-xl font-semibold tracking-tight` |
| Body | `text-base text-text-body` |
| Tech label | `font-mono text-xs uppercase tracking-wider` |
| Flap glyph | `font-flap leading-none font-semibold` — **board only** |

## The board is frozen — and that took work

`flap-tile.tsx`, `board-frame.tsx` and `board-grid-view.tsx` are not restyled. But freezing meant *actively decoupling*, not leaving alone: the glyph used `font-sans`, so changing the app's display face would have moved the metrics `GLYPH_SIZE`'s divisor is tuned to and overflowed wide glyphs on a television.

It now uses `--font-flap`, pinned to an 8KB Inter subset of exactly the 57 characters in `BOARD_CHARS`. A visual no-op today, and a seam forever. Three call sites share it — `flap-tile.tsx`, `console.tsx`'s `FlapSwatch`, and `message-editor.tsx`'s miniature — because one decision in three places drifts.

Do not touch: `GLYPH_SIZE`, `INLINE_GLYPH_SIZE`, the `26` divisor, `scaleX(0.85)`, the rAF loop, or the Tizen constraints at `flap-tile.tsx:11-17` (no `@keyframes`, no `:has()`, no container queries on the TV path).

## Do / Don't

**Do**
- Reuse semantic tokens. A reference's accent becomes `--primary` or `--signal`, never a new hex in JSX.
- Spend amber on state: a lamp, a live indicator, a focus ring. Count the painted elements.
- Use `cn()` for every conditional class; `data-testid` on every interactive element.
- Keep copy in `app/locales/{en,zh}/*.json` — **both**, always.
- Measure contrast before shipping a colour pairing. Two invisible focus rings have already shipped here.

**Don't**
- Don't make amber `--primary`. It paints every CTA in the app and spends the signal everywhere.
- Don't re-declare a `--flap-*` under a theme. A pigment with a dark-mode variant is a category error.
- Don't use `font-flap` outside a flap-shaped object.
- Don't add a blur to create depth. Tonal step, hairline, 1px lip.
- Don't put emojis in the UI. Icons come from `@tabler/icons-react` / `lucide-react`.
- Don't assert on computed colours in tests — **jsdom does not resolve custom properties**.

## Reference lock

Extends the existing hardware lock rather than re-opening it. All four were recorded in this repo when the Refero MCP was available:

| Reference | Traits taken | Recorded in |
|---|---|---|
| **Elektron** (primary) | Tonal ladder, sharp corners, amber strictly as a state signal | `features/phone-control/runs/2026-07-27-progress.md` |
| **Oxide Computer** | Elevation via tonal shift + hairlines, never drop shadows | same |
| **teenage engineering** | Industrial gray as stage, hairline dividers as structure | same |
| **Vestaboard** | The category and price anchor; pigments measured with PIL | `features/split-flap-board/runs/2026-07-27-progress.md` |

**Research degradation, stated plainly.** `REFERO_MCP_TOKEN` is unset by owner decision (round 1, decision 15), so the Refero MCP tools declared in `.mcp.json` are unavailable. Per [`../rules/frontend.md`](../rules/frontend.md) the fallback is the `refero-design` skill's bundled craft references plus tier-1 `ui-ux-pro-max`. No live Refero research backs this direction — it rests on the four locks above and on measurements of the real object.

**Retired:** the Cursor (`4e3b4717-…`) and Linear (`90ce5883-…`) lock, and the "restrained / technical / educational / honest" pillars that came with it. They described a developer boilerplate, which is what this repo was forked from and is no longer.

## Decision ledger

| Decision | Choice | Traces to |
|---|---|---|
| layout | Three surface levels max; tonal steps, never nested cards | Elektron / Oxide |
| type | Archivo + IBM Plex Mono, self-hosted, static cuts on the TV path | closes `console.tsx`'s own "no condensed face ships with the app" |
| colour | Global contract retuned off the object; amber → `--signal` | Elektron — amber is state, never an action surface |
| radius | `0.125rem` | `console.tsx` documents the object as 0px panels / 2px wells |
| elevation | Hairline + 1px lip, no blur | Oxide — elevation via tonal shift |
| motion | Unchanged this phase; when added, at the flap's real cadence | `add-premium-surface.md` step 6 |
| imagery | None. The product renders itself | Vestaboard — the object is the hero |

## Still to come (phases 2–4)

The landing page still markets the starter template, `/dashboard` still exists, and the pairing journey still asks questions it does not need to. Those are phases 2–4 of the approved plan; this document covers the foundation they build on.

## Re-running the research

To extend this direction, run [`/design-research`](../../.claude/commands/design-research.md). To re-open it, say so explicitly and get the owner's confirmation first — that is what happened here, and it ends in a rewrite of this file in the same PR.
