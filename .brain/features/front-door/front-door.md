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

### Design critique

`design-critic` judges the render, never the source, and its verdict is blocking.

**Round 1 → DO NOT SHIP, five P1s.** The useful part of the verdict is *where* it failed. **All nine anti-slop tells passed** — zero cards on the page, no default accent, light by default, the product rendered live at full-bleed scale rather than mocked, `--signal` spent exactly twice, the secondary reference held to its two licensed details, and the rejected direction leaving no residue. It also passed the literalism test, which was the likeliest place to fail: the board informs density and register without becoming scenery — no CSS-drawn case, no fake screws, no painted wall shadow.

It failed on this instead: *"its own structural claim is the worst-executed thing on it."*

| # | Finding | The measurement |
|---|---|---|
| P1-a | The typed state — the page's proof — is its ugliest frame | Typed, the board collapses to one white line pinned to row 1, five of six rows empty: **83% dead tiles**. The visitor's own message renders *less* composed than the demo that invited them to type it — top-aligned instead of centred, and stripped of the amber the demo was given |
| P1-b | The control carrying the claim is the least visible thing on the fold | Well fill **1.14:1** against canvas, boundary **1.42:1**. WCAG 1.4.11 wants 3:1 for a control boundary, so it fails a11y outright — the same defect class as `/link`'s 1.15:1 field in phase 3. Verdict: *"as rendered, it reads as a decorative hero with a newsletter box under it"* |
| P1-c | On the primary viewport the board and the input cannot be seen together | Board ends at 268 CSS px, input starts at 653 — **385px apart, 46% of the viewport**. With an iOS keyboard raised, holding the field in view leaves ~31pt of board on screen. The memorable move happens off-screen at the moment it happens |
| P1-d | In dark mode the page's primary compositional device is absent | Board-band surround vs canvas: **17.77:1 light, exactly 1.00:1 dark**. Not weakened — gone. The board floats in undifferentiated black and what remains is the generic dark-landing silhouette |
| P1-e | The `zh` input invites Chinese the board cannot set | Label and placeholder both invite typing, with nothing saying the drums are Latin until after the refusal |

**P1-e was downgraded on evidence the critic did not have.** It flagged that no `zh`-typed screenshot existed, so the outcome was unproven. Captured it: typing 晚饭七点 leaves the board holding its last displayable message and the `aria-live` region announces, in Chinese, that no character has a flap and *"真正的翻页牌卖到哪里，翻出来的都是同一套字母"*. The runtime behaviour was already right. What was actually wrong is narrower — the warning arrives only after the visitor has been refused.

**Its judgement on the brief, worth keeping:** *"premium landed — the spec table, the hairlines, the mono, the measured numbers. Delightful landed in the copy only… the missing joy is not a colour complaint and should not be fixed with colour — it is P1-a, P1-b and P1-c."*

**On identity:** passes, but *"the load is carried entirely by the object: remove the board band and the type, colour and layout system would not identify this page as anything in particular."*

**Recorded, not fixed:** the board takes 25% of the phone fold against 45% on desktop — a real trade for getting headline, prose, input and CTA all above the fold, which the page does achieve.

**Round 2 → SHIP.** All five P1s landed, no new P0/P1. Verified independently against the pixels rather than taken on trust — it re-sampled the field border itself and got `#5C5C60` on `#FAF9F6` = 6.32:1 and `#B4B4B8` on `#121214` = 9.05:1, and re-measured the board-to-field gap at 66.5 CSS px against the 65 claimed.

Its judgement on the three that mattered, taken as a set: *"the page now reads as delightful in the interaction, not only in the copy. That is a genuine change of state, not 'less broken'… Three separate fixes converged into one gesture, which is what a designed page does and a patched one does not."*

**It caught two things this side had claimed and the pixels did not support**, which is worth more than the verdict:

1. The label regression reported as fixed **was not**. The counter had stopped wrapping; the label itself still orphaned `FOLLOWS` onto a second line at 390, English only. Shortened, re-measured at one line in both themes.
2. The `zh`-typed screenshot **was not a typed state** — counter `0 / 144`, placeholder intact, no focus ring, load flip caught mid-travel. The behaviour had been proven separately but the evidence file did not show it. The capture now waits for the flip to settle, uses the field's own testid, and prints value, counter, hint and board label so a bad capture cannot pass silently again. `0 / 144` is the *correct* counter for four CJK characters — zero of them have flaps — which is exactly why it read as untyped.

Also taken from round 2: the focus bezel was ShadCN's 3px ring plus a recoloured border stacked on the field's own, giving a five-pixel triple amber band and a tan found nowhere else in the system — the heaviest treatment on a page built entirely from 1px rules. Now one 2px outline, the global indicator.

**Refuted, with the reason:** round 2 read the CTA as landing below a real iOS content viewport (~745pt) because it measured `y 740–788` in an 844-pixel capture. The section is `min-h-[calc(100svh-3.5rem)]` and the CTA is bottom-pinned to it — `svh` is the *small* viewport unit, defined as the viewport with retractable browser chrome **shown**, so the headless 844 is the worst case rather than an optimistic one. A screenshot cannot show that. The mobile rhythm was tightened anyway, lifting the CTA 48px.

**The residual, recorded as a brief question rather than a defect:** *"the page has no atmosphere… the household is entirely in the copy, and every rendered surface is instrument-grade black, paper, mono, hairline and spec table. Premium is now emphatic; delightful is now real but it is delight in a control, not in a home."* That is a consequence of the no-imagery lock, so it is the owner's call, not a fix.

## The auth pages

Same feature, same lock, extended not re-opened. The landing page's primary CTA lands here in one tap, so the boundary is the thing that had to hold.

What was here: two near-identical pages behind a split-pane shell whose own docstring said the right-hand column existed *"so engineers evaluating the boilerplate immediately see what's powering the auth flow"* — four explanatory rows and pill badges reading Better Auth, Drizzle, D1, Workers, Effect TS. `auth.json` promised *"a real, role-gated dashboard"*; that route was deleted in phase 2. `common.json` still called the product **CloudFlare SaaS Starter**.

Now one surface behind a segmented Sign in / Create account toggle, with `/login` and `/sign-up` both still real URLs.

**The move that carries it:** a visitor who just scanned the QR on their television arrives with **their own pairing code already set in flaps**, defaulted to Create account — because a person holding a code they minted thirty seconds ago has no account to sign into. Standing in front of the TV, the page shows the same six characters the TV does.

**Where that decision lives, and why it is not where it looks like it should be.** It is in `loginRedirectUrl`, not in `/login`'s loader. Built in the loader first, `/login?next=/link?code=…` bounced to `/sign-up` — which made the Sign in toggle a dead control for exactly the person who needs it, a returning owner adding a second television. Only the gate knows a visitor was *sent* rather than *chose*. `safeNextPath` is untouched and re-applied inside `pairingCodeFromNext`. **The e2e suite caught this, not review.**

### Auth critique — round 1 → DO NOT SHIP, five P1s

The verdict's useful part: the auth pages and the landing page read as *"one product, decisively"* — five separate carriers make the tap seamless. The charge was that **the continuity was borrowed**: *"achieved by wearing the landing's two best components, not by the auth page owning the boundary with an idea of its own."*

| # | Finding | The measurement |
|---|---|---|
| P1-a | The board was a decorative header strip on the two states almost everyone sees | `WELCOME BACK` / `HELLO THERE` carried **zero product information**. Applying this feature's own litmus: delete the band from sign-up and the page loses nothing but its only colour; delete it from a pairing arrival and the page breaks. *"A coffee shop or a boutique hotel could run HELLO THERE in flap yellow over a warm-paper sign-up form unchanged."* This is **slop risk #1, named verbatim in this lock** |
| P1-b | In dark mode the compositional device was gone — the landing's own fix, unpropagated | Header, band and canvas all `(18,18,20)`. Band-vs-canvas **1.00:1**, hairline **1.29:1**. Worse than on `/`, which at least has a 144-tile plate to carry the figure: *"the entire dark page is one flat value plus a 60px yellow strip"* |
| P1-c | At 1440 the right pane was **87% void**, with a rule drawn down the middle pointing at it | Content ended at y=393 in a pane running to y=900; full-height hairline at x=656; perfect 45/55 symmetry, both columns on the same ~460px measure and the same top baseline. *"The two-pane auth shell you deleted has been structurally reinstated with less in it"* |
| P1-d | Sign-in dead-ended, and its spare space held the wrong audience's copy | No recovery affordance anywhere, including on the error state — and the space where one would live printed the TV address and "scan the code on your screen", acquisition copy aimed at somebody who by definition already has an account |
| P1-e | A selected tab and the primary action shared a treatment **and** a label | On sign-up two visually identical blocks 470px apart both read "Create account": same fill (`(31,31,34)` light / `(238,238,242)` dark), same label colour, same 2px radius. In dark they were the two brightest objects on the page and the only two |

**Round 2 — what changed, and the numbers.**

One rule replaced five patches: **the band is a readout — present when there is something to read, absent when there is not.** The flaps now only ever set a string the visitor has to carry to their television.

| State | Band | Delete it and… |
|---|---|---|
| Pairing arrival | the six-character code, live off their own screen | the scan cannot be confirmed |
| Sign-up | `host/tv`, from the request, in flaps with the exact string printed beneath | the page no longer says the one thing about this product nobody can guess |
| Sign-in | **nothing** | — |

- **P1-a.** The greeting is gone and so is the pigment it was spending. Sign-in has no band, because a returning owner has nothing to carry anywhere — refusing to spend the primitive is what stops *"the product is present three times and used once"* being true. A guard was added to the locale parity test: no translatable string may be set in flaps again. The address is capped by `addressFitsFlaps` — past 21 characters a 42-char preview hostname lands at an 8px tile and becomes texture, so the flaps drop and the printed line is promoted, the same caller-side contract as `foldsToFlaps`.
- **P1-b.** The band's edge is now the object's own **aluminium extrusion** (`#414145`, `board-frame.tsx:73`), 3px, and the readout sits in a `FlapPlate` — the frame `BoardFrame` puts around the mask, with its lit top lip. Measured: **1.29:1 → 1.84:1** in dark, 9.65:1 in light, and the plate gives the page the figure it was measured as missing. **The band interior is still 1.00:1 in dark and that is not fixed** — every tonal step available in this palette is 1.18–1.23:1, so a step would have been *worse* than the hairline it replaced. The honest position: the boundary and the object carry it, the interior does not. `BoardBand` is shared with `/` so the two surfaces cannot drift again — which is exactly how this defect reached here.
- **P1-c.** One centred `max-w-md` column. No split, no rule, no aside.
- **P1-d.** Sign-in's register is now `IF YOU CANNOT GET IN`: no password reset exists, said plainly, with no link pretending otherwise — and the two things that *are* true meanwhile (boards untouched; a linked television keeps showing its last message, `DEFAULT_GRANT_TTL_SECONDS`, 30 days, renewed on every socket upgrade). **Password reset was not built** — it is a product decision and stays in Owed.
- **P1-e.** The segmented control is **deleted**, not restyled. There was nothing to encode: the mode is the URL, the `<h1>` says it in words, and the other mode is one inline text link — the device `/` already ships. No fourth encoding of *selected* was invented; `SegmentTrack` / `segmentStyle` remain the console's one archetype. `auth-mode-sign-in` / `auth-mode-sign-up` test ids moved to the links, so the e2e regression guard for a pairing arrival reaching sign-in with `next` intact still drives them.
- **P2-a.** `--destructive` was `#E7000B`, Tailwind `red-600` — the last framework hex in a palette whose spec table advertises pigments *"measured off a real unit"*, and the only chromatic thing on the auth surface. Now `var(--flap-red)` in light and `#e8695f` in dark, the same derivation `hardware-theme.css` made for the console scope. Measured: **5.16:1** on paper, **5.90:1** on the dark canvas, both as border and as icon against a 3:1 floor; white-on-fill improves from 4.79:1 to 5.43:1.
- **P2-c.** The inversion is corrected by *removing* the decorative yellow, not by painting the code — `/tv` sets those six characters unlit and white and their whole job is to match the six on the screen. The pairing state instead gets `/tv`'s **own** pilot lamp: a static `--signal` square before the eyebrow, the same device at `tv.tsx:262`, so both screens carry the same amber at the same moment. Measured: 36px², **1 of 29 painted elements chromatic = 3.4%**, under the 4% accent ceiling; 4.72:1 on paper, 12.38:1 in dark.
- **P2-d.** The eyebrow is one component with `[&:lang(zh)]:text-[13px]` — `:lang()` matches on inherited language, so it reads `<html lang>` with no prop threading. 11px is below the floor for a Han glyph; the letterspacing is kept, because CSS `letter-spacing` does apply between Han glyphs and loose-set CJK reads as deliberate. **Partially fixed, honestly:** the mono *texture* still does not survive, because the CJK fallback face is not IBM Plex Mono. Size and tracking are what could be fixed without shipping a CJK mono.
- **P3-a.** The compact `LanguageSwitcher` is bare — no border, no fill, `hover:bg-accent`, 44×44 — so it and the theme toggle are two peers with one treatment. Fixed in the component, so `/` gets it too.

**Two defects found while measuring, both pre-existing and neither reported:**

1. The wordmark link measured **133 × 20** on both the landing page and the auth pages — a 20px-tall target, under WCAG 2.5.8's 24px AA floor, never mind the 44px this project sets. `inline-flex h-11` on both.
2. `authLinks` (the flap-font preload) was first declared in `auth-route.ts`. `links` is a *client* export, so React Router pulled that module — and `i18n.server` with it — into the browser and took the whole auth surface down with `Server-only module referenced by client`. In a dev server that still renders and still screenshots. It lives in `auth-links.ts` now, and the capture script asserts a route-specific testid **and** `document.fonts.check` before it writes any file, because a hung Worker serves an error page with a silent console.

**Refuted, with evidence.** Round 1's P2-b claimed the pairing copy (*"Those six flaps are the code on your screen"*) lied, because `/tv` renders the code as letterspaced Archivo — citing a screenshot the critic itself caveated as dated 29 July and belonging to another feature. It is stale: `/tv` was rebuilt in phase 3 and renders the code as six real flap tiles on a lipped plate (`docs/assets/tv-pairing.png`). The copy is unchanged.

### Defects found in this lane, all pre-existing

| Defect | Detail |
|---|---|
| `ui/select.tsx` carried `outline-none` | The **fourth** component in this repo to do so, after `button.tsx` (phase 1) and `input.tsx` / `textarea.tsx` (phase 3). It emits `outline-style: none`, killing the global `:focus-visible` outline *and* the forced-colors fallback under it, where `box-shadow` is stripped and the outline is the only indicator left. Measured: the focused language switcher reported `outline-style: none` while every other control on the page reported `solid 2px` |
| The language switcher was **44×36** | On the landing page *and* both auth pages. `SelectTrigger` sets its height behind a `data-[size=default]:` variant, which outranks a plain `h-11` on specificity — and **tailwind-merge does not dedupe across a variant boundary**, so a caller passing `h-11` silently got 36px, under the 44px floor the phone-first constraint sets. Fixed once in `LanguageSwitcher`; 44×44 on all three surfaces, measured |
| Better Auth's English server string rendered verbatim | A `zh` visitor met "Invalid email or password". Now mapped for the two codes read off the live endpoint, keeping the server's words for anything else |
| "Forgot password?" pointed at `href="#"` | No reset route exists. The dead link is gone; **the missing capability is a product decision and is recorded as owed, not silently dropped** |

### Slop risks named up front

1. **Collapsing the one thing we can render.** Showing the board as a screenshot, or hand-rolling "board-ish" rounded squares, or demoting it to a decorative header strip. *Litmus: if the first viewport survives with the board removed, the board is decoration and the page failed.*
2. **Cards by inheritance.** The page being deleted is six `FeatureCard`s plus three `Card`-based pillars. The pull toward "three cards: Type it · Ask the LLM · Put it on TV" is enormous and would be indistinguishable from the thing being removed.
3. **Dark-by-default plus token role drift.** The hardware surface is legitimately dark, which supplies a ready-made excuse to paint the landing black and the CTA amber. Both are wrong.

## Changelog

| Date | Change |
|------|--------|
| 2026-08-01 | Auth critique round 1 (DO NOT SHIP, five P1s) answered. The band became a readout — the TV address in flaps on sign-up, the code on a pairing arrival, nothing on sign-in — the segmented control was deleted, the two-pane shell became one centred column, sign-in got an honest locked-out register, and `--destructive` was re-derived from the measured flap red. `BoardBand` / `FlapPlate` are shared with `/`. |
| 2026-07-31 | Auth pages merged into one toggled surface; the pairing arrival lands on Create account with the code in flaps. Four pre-existing defects fixed, incl. `outline-none` in `ui/select.tsx` (the fourth component) and a 44×36 language switcher on three surfaces. `stack-badge.tsx` deleted. |
| 2026-07-31 | Landing page built and shipped. `design-critic` round 1 DO NOT SHIP (five P1s) → round 2 SHIP. `feature-card.tsx` deleted. README refreshed. |
| 2026-07-31 | Scoped as feat-022. Claimed in-progress; `/design-research` dispatched for the landing surface. |

### Auth critique

**Round 1 → DO NOT SHIP, five P1s.** The board was a decorative header strip on the two states almost everyone sees (`HELLO THERE` / `WELCOME BACK`) — **slop risk #1 named verbatim in this feature's own lock**. Dark measured 1.00:1 band-vs-canvas: the landing's own P1-d, unpropagated one tap downstream, and worse because there was no large board to carry the figure. The 1440 right pane was 87% void with a full-height rule drawn down the middle — *"the two-pane auth shell you deleted has been structurally reinstated with less in it."* Sign-in dead-ended on bad credentials while its spare space held the landing's acquisition copy. And a selected tab and the primary action shared a fill **and** a label — two identical blocks 470px apart both reading "Create account", the two brightest objects on the dark page.

**Round 2 → SHIP.** All five landed, no new P0/P1, and it re-derived the numbers rather than accepting them: the rail sampled at `rgb(65,65,69)`, 6 device px, on canvas `rgb(18,18,20)` = **1.843:1**, matching the claim to two places.

On the boundary, which round 1 had charged with *"wearing the landing's two best components"*: the landing's board is a bare grid inset in the band; the auth board sits in a `FlapPlate` with an extrusion frame and lit lip that appears nowhere on `/`, sets a request-derived string rather than a fixed marketing one, and is conditional on state. *"Shared chassis, auth-owned idea. Round 1's charge no longer stands."*

**Refuted, with the reason:** round 1 claimed the pairing copy lies because the TV renders plain glyphs rather than flaps. It cited a 29 July capture belonging to another feature and correctly caveated it as possibly stale. It is — `/tv` was rebuilt in phase 3 and renders six real tiles.

**Carried, not claimed:** the dark band interior is still exactly 1.00:1. Every tonal step in the dark palette measures 1.18–1.23:1 against the canvas, so a fill would have been *weaker* than the boundary it replaced. The device moved rather than the value, and the critic accepted that as legitimate — but it is recorded as partial.

**The residual, measured:** landing 0.226% chromatic pixels → one tap → sign-up **0.000%**, at every viewport and both themes. The decorative greeting's amber was correctly removed and nothing replaced it. Held at P2 because *"coldness is not sloppiness"*, but the honest answer to "did it get warmer" is no — it was resolved by subtraction. Same brief question as the landing's residual, and the owner's call.

## Owed

- **A password-reset route does not exist.** The dead `href="#"` link is gone and `/login` now *names* the gap in the visitor's own language rather than leaving silence where a link should be (`locked_out.*`), but a household that forgets its password still has no path back. No route, no token store, no mail transport. Product decision, raised with the owner separately.
- **The `zh` eyebrow has no mono texture.** Size and tracking were fixed; the face was not, because the CJK fallback is not IBM Plex Mono and shipping a CJK mono is a font-budget decision. See P2-d above.
- **The physical-TV check**, inherited from phase 3 and still open. `FlapWord` states its size as explicit width/height rather than `aspect-ratio` because the Tizen panel is Chromium 56 — reasoning from a documented constraint, not a measurement on the glass. The pairing code is what a family reads across a room.
- **Atmosphere.** See the round-2 residual above: the household lives entirely in the copy. A brief question for the owner, not a defect.
