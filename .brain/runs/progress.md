# Progress — Rolling session log

> Single rolling log of "where am I right now". Append-only. Newest entry on top. **Per-task deep state lives in `<YYYY-MM-DD>-<task-slug>.md`** — this file is the index/state cursor.

## How to use

- **Start of session**: read the top entry to recover state.
- **During session**: append one bullet per meaningful checkpoint (decision, blocker, branch switch, test failure, scope change).
- **End of session**: add a `## Session end` block with: branch, last commit SHA, what's running/incomplete, what to do next.
- **Multi-day task**: link to the run note (`runs/<date>-<slug>.md`) for full detail. Keep entries here under ~5 lines each.

## Format per entry

```
## YYYY-MM-DD HH:MM (UTC) — <one-line summary>
- branch: <branch-name>
- in-progress feature: <feat-id> | none
- run note: <path or none>
- next: <one sentence>
```

---

## 2026-07-27 — Plan is nearly complete. feat-007 split-flap-board and feat-008 phone-control shipped; feat-009 llm-board-agent in-progress with phase 5 (generation) landed at 20/20 valid grids on the real model. Board management shipped too (create/list/rename/delete + copyable TV URL), and the TV display plus phone controller were both restyled to a measured Vestaboard-industrial language. 643 tests green.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Two agents in flight: phase 6 voice input (Whisper + hold-to-talk, first consumer of the AI binding — must report whether it is reachable locally) and realistic multi-step flap travel + clatter (3-5s, one rAF loop, measured frame timings). Then: per-cell colour control in the editor (needs control.tsx + message-editor + locales, blocked on the voice agent; no schema change required since segments are already an array), export the tile pigment constants from flap-tile.tsx so console.tsx stops duplicating them, re-verify the display because the phase 3 flip timings go stale, then ship feat-009.

---

## 2026-07-27 — shipped phone-control: Phase 4 complete and verified. feature-verifier verdict PASS (.brain/features/phone-control/verifications/2026-07-27.md)
- branch: `main`
- in-progress feature: none
- run note: none

---

## 2026-07-27 — shipped split-flap-board: Phases 1-3 complete. feature-verifier verdict PASS (.brain/features/split-flap-board/verifications/2026-07-27.md), 8 scr
- branch: `main`
- in-progress feature: none
- run note: none

---

## 2026-07-27 — Phase 2 (persistence + realtime room) landed and verified live: D1 board/board_snapshot + BoardRepository, BoardRoom Durable Object with WS hibernation, BOARD binding in both envs, pure protocol module, tRPC board router, /api/board-ws upgrade route. 417 tests green, typecheck 0, build 0. Two-client sync measured 1.5ms vs a <300ms bar; board isolation and socket-path D1 persistence both proven (board.revision=4 matching snapshots 1-4). Also fixed a CRITICAL latent bug: a merged Effect layer builds every member, so the missing R2 binding was failing AuthApi and 500ing every request — Bucket is now provided ad-hoc, not globally.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Phase 3: TV display route /b/:boardId — 144 flap tiles, CSS flip animation, per-cell colour, WS subscribe, QR overlay, SFX pack + one-time audio-unlock tap, visibilitychange wake-resync. Samsung Tizen browser is the target so keep CSS conservative. Acceptance: feature-verifier PASS with screenshots (idle, mid-flip, QR, audio prompt) + a manual pass on the real TV.

---

## 2026-07-27 — Baseline unblocked: typecheck exit 0, 294/294 tests green. R2 gap parked per decision — file-upload code kept, bucket.test.ts envLayer widened with { BUCKET?: R2Bucket } to match the existing pattern in app/services/bucket.ts; gap recorded in feat-003 evidence with the exact steps to undo when R2 returns.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Phase 2 of split-flap-board: D1 board + board_snapshot tables (Drizzle migration), BoardRepository (Effect.Service), BoardRoom Durable Object with WebSocket hibernation, BOARD binding + migrations tag in wrangler.jsonc for default and preview envs, tRPC board.get/setMessage/history. Acceptance: two tabs sync under 300ms, boards isolated by id, bun run build passes.

---

## 2026-07-27 — split-flap-board phase 1 (domain core) landed: app/lib/schemas/board.ts + app/lib/board/{compile,repair}.ts with 43 new unit tests — 294/294 green. Compiler owns the 6x24 invariant (charset fold, colored-space-is-a-tile wrap rule, greedy wrap + hard split, align, loss reporting); repairMessage is total over a 24-case adversarial fuzz corpus.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Decide on the pre-existing typecheck failure (bucket.test.ts BUCKET not in Env — starter shipped file-upload with no r2_buckets binding), then start phase 2: D1 board/board_snapshot tables + BoardRepository + BoardRoom Durable Object + BOARD binding.

---

## 2026-07-27 — flappyboard MVP plan approved (round 2): 6x24 split-flap board, Durable Object realtime, QR scan-to-pair phone controller, walkie-talkie LLM generation on claude-sonnet-5 with schema decode + retry-twice-then-repair. 7 decisions answered in brain review; features feat-007 split-flap-board / feat-008 phone-control / feat-009 llm-board-agent registered as planned.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Start phase 1 of split-flap-board: Effect Schema (BoardMessage/BoardGrid, palette, charset) + layout compiler + repair pass + unit/fuzz tests. No UI, no network.

---

## 2026-07-23 — Harness adopts brain-axi CLI as primary interface (hybrid): slash commands + harness-check.sh wrap brain check/ship/progress; docs (AGENTS/HARNESS/README/recipes) rewritten; CI installs brain-axi
- branch: `docs/readme-harness-loop-in-the-wild`
- in-progress feature: none
- run note: none
- next: create-pr-with-review

---

## 2026-07-15 — audit-remediation shipped
- branch: `refactor/audit-remediation` (PR opening; from main @ 8547acb)
- in-progress feature: none (cross-cutting quality task, closed)
- run note: `.brain/runs/2026-07-15-audit-remediation.md` (closed)
- shipped: 4-agent audit → 5-agent remediation (security, Effect core, DRY, i18n, +71 tests → 228), Greptile pre-PR review resolved (SVG dropped from upload allowlist, magic-byte sniffing added)
- next: merge PR; optional follow-ups — route FileUpload somewhere, feature-verifier walk of admin flow

---

## 2026-07-13 — feat-005 merged + released v1.1.0 — session end
- branch: `main` @ 4f83efc (PR #7 merged)
- in-progress feature: none
- run note: `.brain/runs/2026-07-10-preview-deployments.md` (closed)
- shipped: v1.1.0 "Every PR Gets Its Own SaaS" — per-PR preview deploys w/ isolated seeded D1, full lifecycle verified on PR #7 (open→deploy→login→close→cleanup→reopen)
- outstanding: roll CF API token (leaked to session transcript); decide keep-vs-teardown of session CF resources; run-note final edit uncommitted on main

---

## 2026-07-11 — feat-005 preview-deployments shipped
- branch: `main`
- in-progress feature: none
- run note: `.brain/runs/2026-07-10-preview-deployments.md`
- verification: per-PR D1 binding confirmed (pr-999 version upload), alias URL signup 200 with preview-D1 user row written (pr-test), prod signup 200.
- next: teardown session-provisioned resources (`bun run teardown`).

---

## 2026-07-10 — feat-005 preview-deployments added to feature_list.json (in-progress)
- branch: `main`
- in-progress feature: feat-005 (preview-deployments)
- run note: `.brain/runs/2026-07-10-preview-deployments.md`
- next: registered in `feature_list.json` + `.brain/features/preview-deployments.md` created; continue implementation per run note.

---

## 2026-07-10 — Preview deployments + DX (research → implement) — in progress
- branch: `main`
- in-progress feature: feat-005 (preview-deployments, to be added to feature_list)
- run note: `.brain/runs/2026-07-10-preview-deployments.md`
- baseline: typecheck FAIL + harness-check FAIL — both pre-existing, caused by intentionally-absent `wrangler.jsonc` (generated by `bun run setup`); tests 123/123 PASS
- blocker: wrangler OAuth expired — user must `wrangler login` before provisioning
- next: consume research-agent reports, provision CF env non-interactively, design preview-deploy pipeline

---

## 2026-05-07 — Effect-TS API audit: rules + boundary refactor + bulk ops + logging — closed
- branch: `main`
- in-progress feature: none
- run note: none (rule + targeted code edits)
- scope: surveyed API surface for Effect-TS idiom gaps, codified rules, applied where it mattered, left simple CRUD untouched.

### Rule additions
- **HTTP boundary (non-tRPC) pattern** in `rules/routes.md` — `runPromiseExit` + `Exit.match` + `Effect.catchTag(s)`, no `try`/`catch`. Recoverable in catches, defects in `onFailure`. Anti-patterns: try/catch around runPromise, duck-typing `TRPCError.code`.
- **`Effect.promise` vs `Effect.tryPromise`** table in `rules/services.md` — `tryPromise` for any fallible promise (Better Auth, fetch, drizzle, third-party); `promise` only for known-infallible.
- **Procedure-level error transformation** section in `rules/routes.md` with operator table (`catchTag(s)` / `retry` / `partition` / `tap` / `tapErrorTag` / `timeout`) + worked `deleteUser` example. Default = fall-through; only transform for complex procedures.
- **Logging — Effect logger vs imperative `loggers.X`** in `rules/services.md` — same sink (`emitLog` via `LoggerLive`); pick by context. Effect inside `Effect.gen`, imperative outside. Canonical shape `Effect.logInfo("event").pipe(Effect.annotateLogs({...}))`; never `logInfo({...}, "event")` (fields would JSON-stringify into message string).
- Cross-refs added in `codebase/effect-ts.md` "What Not To Do" + `rules/errors.md` "Using errors in tRPC procedures".
- New anti-patterns: `?.` on `ctx.auth.user` after protected/adminProcedure, `Effect.promise` for fallible work.

### Code changes
- `app/routes/api/upload-file.ts` — rewritten to `runPromiseExit` + `Exit.match` + `Effect.catchTag("ValidationError")`. Removed try/catch + duck-typed `TRPCError.code`. `app/components/file-upload.tsx` narrows `fetcher.data` with `"success" in` / `"key" in` guards.
- `app/trpc/routes/admin.ts` — `bulkBanUsers` / `bulkDeleteUsers` / `bulkUpdateUserRoles` now (1) return idempotent `{ success: true, affectedCount: 0, skippedCount }` on no-valid (was: 400 ValidationError — wrong semantics, input was valid), (2) emit structured audit log via `Effect.tap` + `Effect.logInfo("users.bulk_*").pipe(Effect.annotateLogs({ actor, targets, affectedCount, skippedCount, ... }))`.
- `app/lib/effect-trpc.ts` `runProcedure` — wraps every procedure in `Effect.annotateLogs({ layer: "trpc" })` for auto layer-tag parity with imperative `loggers.trpc`.

### Skipped (intentionally)
- Procedure refactors for simple CRUD — default `tagToTRPC` fall-through is correct.
- Helper extraction for bulk ops — defer until 4th lands.
- `Effect.partition` per-user in bulk — single bulk UPDATE keeps atomicity; partial-success UX not needed for ban.

### Still open (separate task)
- `app/trpc/index.ts:14-18` — `Effect.promise` → `Effect.tryPromise` for Better Auth `getSession`.
- `app/trpc/router.ts:43` — redundant `?.` on `ctx.auth.user`.

### Verify
- typecheck PASS, unit 123/123 PASS at every checkpoint.

---

## 2026-05-07 — Boilerplate UI polish v3 (Mandarin + live toggle + e2e cleanup) — closed
- branch: `main`
- in-progress feature: none
- run note: `.brain/runs/2026-05-07-boilerplate-ui-polish.md`
- verify: typecheck + unit (123/123) + e2e (auth.spec 2/2) PASS
- changes: added zh locale (6 ns files), `LanguageSwitcher` wired into home / auth / dashboard, new `/api/set-locale` action, replaced docs+i18n e2e specs with focused `auth.spec.ts`, fixed live-toggle race via `useFetcher` + root revalidation
- next: none — to add a locale, drop `app/locales/<lng>/*.json` + add to `supportedLngs` + add label to LanguageSwitcher.

---

## 2026-05-07 — Boilerplate UI polish v2 (harness section + v2 label) — closed
- branch: `main`
- in-progress feature: none (cross-cutting polish over feat-001, feat-002)
- run note: `.brain/runs/2026-05-07-boilerplate-ui-polish.md`
- verify: typecheck + unit PASS (123/123), e2e i18n 6/8 (same 2 pre-existing fails — no regression)
- changes: hero eyebrow → v2; new "An agent harness, not just a stack" section on `/` with 3 pillars + commands block; `meta.description` updated; new `home.harness.*` i18n keys.
- next: replace placeholder GitHub URLs with real repo on publish; pre-existing 404 i18n namespace + dead docs.spec follow-up.

---

## 2026-05-07 — Boilerplate UI polish (home / login / dashboard) — closed
- branch: `main`
- in-progress feature: none (cross-cutting polish over feat-001, feat-002)
- run note: `.brain/runs/2026-05-07-boilerplate-ui-polish.md`
- baseline: PASS; verify: typecheck + unit PASS, e2e i18n 6/8 (2 pre-existing fails unrelated), docs.spec dead (pre-existing)
- shipped: refero-synthesized `design-system.md`; redesigned home / login / sign-up / dashboard with split-pane auth + educational cards; new `StackBadge` + `AuthShell` components.
- next: replace placeholder GitHub URLs with real repo on publish; fix pre-existing 404 i18n namespace bug + dead docs.spec in a follow-up.

---

## 2026-05-07 — Harness hardening pass
- branch: `feat/effect-ts`
- in-progress feature: harness itself (no feat-id; meta)
- run note: none
- changes: type-locked `tagToTRPC` (AppError + assertNever), `harness-check.sh` brain dead-link check + wired into `init.sh --baseline`, added `.github/workflows/ci.yml` (baseline + build + e2e + non-negotiables grep), `99-verify-done.md` flipped e2e default-on, `HARNESS.md` Verification table updated, `add-tagged-error.md` recipe updated for AppError union requirement
- next: commit + push to exercise CI on first PR

---

## 2026-05-07 — Harness upgrade (5-subsystem alignment)
- branch: `feat/effect-ts`
- in-progress feature: harness itself (no feat-id; meta)
- run note: none
- changes: added `feature_list.json`, `init.sh`, this `progress.md`, `HARNESS.md`, sub-agents in `.claude/agents/`, SessionStart hook
- next: verify init.sh runs clean → commit harness upgrade
