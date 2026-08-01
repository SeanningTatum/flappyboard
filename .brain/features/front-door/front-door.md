# Feature: Front Door

_Last updated: 2026-07-31_

## Purpose

The public landing page and the auth pages — everything a visitor sees before they have an account. This is phase 4 of the brand/IA/UX redesign (`~/.claude/plans/i-want-us-to-optimized-lightning.md`), and it is the last surface still wearing the boilerplate the project was forked from.

What is there today is not a weak landing page, it is **the wrong product's** landing page. `app/routes/home.tsx` returns `title: "Cloudflare SaaS Starter"`, six cards advertising the stack (Workers, D1, Better Auth…), a Quickstart block printing `bun install`, and — the sharpest tell — a section printing `/start-task` and `.brain/recipes/` paths **to end users**. A family looking for a message board for their TV is being sold a SaaS template.

It is replaced by one screen that does the only three jobs a front door has here: show the product actually working, say what to do next, and hand over the one instruction the product has never given anywhere — *on your TV's browser, go to `yourhost/tv`*.

## When It's Used

- A visitor lands on `/` with no session.
- A visitor lands on `/` **with** a session — `resolveSignedInHome` (`app/lib/session.ts`) already redirects them to their board or the rack, so the landing page is genuinely public-only.
- A TV holder scans the QR on `/tv` while signed out — `/link` bounces to auth with `next` carrying the pairing code, and the auth page must default to **sign-up**, because someone scanning a code they just minted has no account yet.

## How It Works

Static route with a loader that supplies only the host for the `yourhost/tv` instruction (the visitor cannot be expected to know their own deployment's origin). No database access, no session requirement beyond the existing signed-in redirect.

The headline is not text styled to look like a board — it **is** a board, rendered by the same frozen primitives the TV uses. Locked decision 4: it flips once on load, then rests. Not a loop; a loop turns the product's one memorable behaviour into background noise, and it fights `prefers-reduced-motion`.

### Testability

Unit: the loader's host derivation and any pure copy/CTA resolution. i18n parity is guarded by the locale parity test — `home.json` exists in both `en` and `zh` and every key must match. Browser proof: `.brain/features/front-door/verifications/<date>.md`, plus a `design-critic` pass on the render (any P0/P1 blocks).

## Key Files

| File | Role |
|------|------|
| `app/routes/home.tsx` | The landing page — rewritten from 400 L of boilerplate |
| `app/routes/login.tsx`, `app/routes/sign-up.tsx` | Merged into one toggled page |
| `app/locales/{en,zh}/home.json` | Copy, both locales |
| `app/components/board/flap-word.tsx` | The flap primitive the headline is set in |
| `app/components/feature-card.tsx` | **Deleted** with the old page |

## Dependencies

- feat-019 `brand-system` — tokens, the two typefaces, the 2px radius, `--signal`
- feat-020 `app-ia` — `resolveSignedInHome`, the redirect shims
- feat-021 `console-journey-v2` — `FlapWord`, the hardware surface scope

## Design research

Ran `/design-research` 2026-07-31. **Stance: extending** the locked direction (`codebase/design-system.md`, phase 1) — nothing here re-opens the Elektron / Oxide / teenage engineering / Vestaboard lock, the typefaces, the 2px radius, amber-as-`--signal`, or the frozen board.

**Recorded degradation.** Refero MCP was unavailable — `REFERO_MCP_TOKEN` is unset by owner decision (locked decision 15, review round 1), so steps 4–5 ran degraded. No Refero UUID appears below and none was invented. Substituted: the `refero-design` skill's bundled craft references, `ui-ux-pro-max` v2.11.0 for the a11y floor, the repo's own dated reference locks, and **five live page fetches performed for this task** — the only non-repo evidence behind the directions.

### References

| Source | URL | Role |
|---|---|---|
| Panic Playdate | https://play.date/ | **Primary.** Founder voice; the one weird feature named and defended out loud; a concrete commitment above the fold; personality carried by copy and one interaction, not colour |
| teenage engineering EP-133 | https://teenage.engineering/products/ep-133 | Secondary, **bounded to two details**: the spec table as a page section, and the TV address printed as a spec row |
| Vestaboard | https://www.vestaboard.com/ | Studied and **rejected as a direction** — see below |
| Tidbyt | https://tidbyt.com/ | Category study only |
| Daylight DC-1 | https://daylightcomputer.com/ | Category study only |

**The bar the category sets** (none of it optional, all five products do it): the object is in viewport one at real scale — never a UI screenshot in browser chrome; the first line says what the thing *is* in plain words; something concrete and committing sits above the fold; one weird detail is owned proudly in the brand's own voice; specs are brand media, not footer material. **None of the five uses a feature-card grid as its primary explanation** — which is exactly what this page is being rewritten away from.

### Dominant direction — "Say something"

**You drive the board before you sign up.** A real text input under a live board: the visitor types on the phone they are holding and the flaps move, before any account exists. The page *is* a controller, which is the owner's own thesis about the product, demonstrated rather than claimed.

Vestaboard structurally cannot offer this — they cannot let a stranger drive a $3,000 mechanical object from their homepage. We can, because our flaps are software. It is the single most memorable move available in this category and it is exclusively ours.

**Direction A ("the object on the wall", Vestaboard) was rejected outright rather than blended in.** It fails the anti-slop identity test: swap our wordmark for Vestaboard's and its first viewport still works. Synthesis is choosing and adapting, not finding the safe intersection.

### Decision ledger

| Axis | Choice | Traces to |
|---|---|---|
| **Layout** | Live board → one sentence → a real input → CTA → the TV instruction → a spec table. No cards anywhere; the spec table replaces every grid the old page had | Playdate's section rhythm; the table from EP-133 |
| **Layout** | Board composed via `BoardGridView variant="inline"` — it drops the enclosure and sizes off its container. `BoardFrame` is hard-locked to `h-screen w-screen` and cannot be composed inline | Repo constraint, `board-frame.tsx:64` |
| **Type** | Archivo for display at genuine scale; IBM Plex Mono for the TV address and every spec value. `--font-flap` stays board-only | Phase-1 lock; EP-133's weight-and-caps emphasis |
| **Type** | The `<h1>` is real prose, not flaps. The flaps spell a **fixed, language-neutral Latin string in both locales** — `BOARD_CHARS` is Latin by construction so `foldsToFlaps` (`flap-word.tsx:174`) is false for all of `zh`. This is honest to the object: a real split-flap shows Latin flaps to a Chinese owner too | Repo constraint |
| **Spacing** | Asymmetric whitespace, hairline `--border` rules between sections, no card padding boxes. 4px rhythm | EP-133 |
| **Motion** | One flip on load, then rest — **then user-initiated flips only, never a loop.** This extends locked decision 4 and was put to the owner explicitly; approved 2026-07-31 | Decision 4 + owner extension |
| **Motion** | Reduced motion needs no new code — `board-grid-view.tsx:343,416,584` already implements a no-travel path and `flap-tile.tsx:336-340` keeps it a class, not an inline duration. The single flip degrades to a snap for free | Repo constraint |
| **Imagery** | **None.** No photography, no video, no product shot, no browser chrome. The only media is the live board — a code-native primitive stronger than any product shot | Anti-slop tell #9 |
| **Copy** | Object-first and plain. Roughly four sentences: what it is, the invitation to type, the TV instruction, the CTA. One short self-aware line answering *"is this just a screensaver?"* | Playdate's *"Is it a gimmick? Nah."* rhythm |
| **Copy** | `yourhost/tv` is selectable text in mono, printed twice — once as a lit instruction, once as a spec row. It is the one thing about this product nobody can guess and the app has never said anywhere | EP-133's connection-detail placement |
| **Colour** | Warm paper `--background`, ink `--primary` CTA. **The CTA is never amber** — `--signal` is a pilot lamp, and spending it on the first click of the funnel spends the signal | Phase-1 token contract |

### Token map

No new token, and no hex in JSX. Canvas `--background` · headings `--text-heading` · body `--text-body` (10.43:1 light / 12.05:1 dark) · CTA `--primary`/`--primary-foreground` · lamp beside the TV address `--signal` · rules and spec rows `--border` · the input well `--input` · radius `--radius` (2px — the CTA is a rectangle, never a pill) · the board's own pigments `--flap-*`, theme-invariant and finally spent.

**Two traps for anyone editing this page:** `--hw-*` resolve to **empty** at `:root` — the landing is an app surface, so every hardware value has an app-surface equivalent above. And a full-bleed dark band around the board is `className="dark"`, the mechanism the repo already uses, not a restated hex.

### Slop risks named up front

1. **Collapsing the one thing we can render.** Showing the board as a screenshot, or hand-rolling "board-ish" rounded squares, or demoting it to a decorative header strip. *Litmus: if the first viewport survives with the board removed, the board is decoration and the page failed.*
2. **Cards by inheritance.** The page being deleted is six `FeatureCard`s plus three `Card`-based pillars. The pull toward "three cards: Type it · Ask the LLM · Put it on TV" is enormous and would be indistinguishable from the thing being removed.
3. **Dark-by-default plus token role drift.** The hardware surface is legitimately dark, which supplies a ready-made excuse to paint the landing black and the CTA amber. Both are wrong.

## Changelog

| Date | Change |
|------|--------|
| 2026-07-31 | Scoped as feat-022. Claimed in-progress; `/design-research` dispatched for the landing surface. |
