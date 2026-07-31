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

## 2026-07-31 — Synced cf-saas-starter-react-router 3b1b899..9a70e55 onto chore/sync-template (5 commits). Fork point identified as template 3b1b899 (2026-07-24) — our 80e73a8 'Initial commit' tree is byte-identical there outside .brain/README, and the two repos share no git history, so this was cherry-pick-with-adaptation, not merge. Took: rule-router PreToolUse hook (#16, harness-check now 10 checks incl. 58 hook-test assertions), test-author sub-agent (#18), OTel span tracing (#20) extended with all 20 board.ts procedures upstream never saw (35 spanned total, new feat-018), design gate (#21 — design-critic + ui-builder agents, /design-research, /build-feature, scripts/design-audit.ts, refero .mcp.json, ui-ux-pro-max plugin replacing frontend-design). Skipped: template .brain/CHANGELOG.md + runs/progress.md + feature_list churn, and the sample-saas-landing folder (26 PNGs for a /demo surface cut before the template PR merged) with its 4 references rewritten. The tRPC isDev fix (#17) did NOT apply — we already fixed it, more strictly: omitStack runs unconditionally where upstream only strips outside dev, and our delay branches on import.meta.env.DEV so the bundler deletes it. Took its rules/routes.md doc adapted to our helpers + its 100-499ms off-by-one correction.
- branch: `chore/sync-template`
- in-progress feature: none
- run note: none
- next: PR chore/sync-template -> main. Two owner calls surfaced by the sync: (1) upstream's runs/2026-07-30-focus-ring-defect.md reports keyboard focus rings never painting app-wide in the app/app.css we inherited at the fork point — plausibly live in flappyboard, NOT confirmed here, needs a keyboard walk on /b/:boardId, /link, /tv, console; (2) .mcp.json + extraKnownMarketplaces add a third-party plugin (nextlevelbuilder/ui-ux-pro-max-skill) and an external MCP endpoint needing REFERO_MCP_TOKEN — accept or drop. Also owed: a flappyboard OTLP capture (feat-018 is upstream-verified only; export inert until OTEL_EXPORTER_OTLP_ENDPOINT set). Pre-existing drift noticed, not fixed: .brain/features/index.md table lists 6 features with stale statuses vs feature_list.json's 18.

---

## 2026-07-30 — Stack consolidated: PR #9 squash-merged into `feat/qr-first-pairing-console` (8e3202c), so PR #8 is now the single PR to `main` carrying all four features (feat-014 qr-first-tv-link, feat-015 controller-board-mirror, feat-016 pairing-experience-redesign, feat-017 auto-tv-link). PR #8 body rewritten to describe the consolidated scope; `feat/auto-tv-link` deleted (merged). Brain state reconciled onto the base branch: this cursor, the feat-014 run note's Greptile step, and four `pr.json` markers. `wrangler.jsonc` (feat-013 KV IDs) stays owner-managed and out of the branch.
- branch: `feat/qr-first-pairing-console`
- in-progress feature: none
- run note: none
- next: PR #8 → `main`. CI blocker is **not** this PR: `preview.yml` "Deploy preview" has failed on every run since it was added — `wrangler versions upload` uploads fine but prints no `Version Preview URL` / `Version Preview Alias URL`, so URL extraction exits 1. Preview URLs are a non-versioned Worker setting; the one-time owner fix is `bun run deploy:preview` (same bootstrap class as the documented DO-migration 10211 case). Owner calls still open: TV power-cycle cookie survival, 8h kiosk soak, wedged-socket invisibility, revoke-all dead rows. feat-013 live-weather remains the only planned feature (KV provisioned).

---

## 2026-07-29 — PR #9 opened (stacked on #8): feat-017 auto-tv-link — scan, sign in, done. /link loader auto-resolves obvious accounts (0 boards: create Living Room/客厅 + pair; 1 board: pair it; many: picker; ?manual=1 pre-pairing escape). Greptile review (confidence 2) found 2 real defects fixed in 817374b: board.list failure silently read as 0 boards (phantom create) and spent code left in URL (refresh showed misleading error) — success now redirects to /link?paired=<id>, receipt refresh/back-safe. Security finding (any authenticated GET pairs) owner-ratified accept+document in route comment. Re-verified post-fix 13/13 PASS (fresh sign-up headline flow unchanged, clean-URL receipt). Gate: typecheck 0, 1207 tests, build 0, e2e 2/2, harness clean. 3 commits on feat/auto-tv-link.
- branch: `feat/auto-tv-link`
- in-progress feature: none
- run note: none
- next: Merge order: #8 then #9 (stacked). feat-013 live-weather remains the only planned feature (KV provisioned). Owner calls still open: TV power-cycle cookie survival, 8h kiosk soak, wedged-socket invisibility, revoke-all dead rows.

---

## 2026-07-29 — PR opened for auto-tv-link: https://github.com/SeanningTatum/flappyboard/pull/9
- branch: `feat/auto-tv-link`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — shipped auto-tv-link: Browser-verified PASS (.brain/features/auto-tv-link/verifications/2026-07-29.md, 16 assertions, 6 scenarios): HEADLINE f
- branch: `feat/auto-tv-link`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — PR #8 opened: feat/qr-first-pairing-console (2 commits, 57 files) ships feat-014 qr-first-tv-link + feat-015 controller-board-mirror + feat-016 pairing-experience-redesign. Greptile pre-PR review ran (confidence 3, 3 findings): P1 /\evil.com scheme-relative bypass in safeNextPath verified against new URL and fixed owner-approved in 4a09892 with regression tests; 2xP2 auto-fixed (closure narrowing, missing /\ test). PR body embeds 6 verification screenshots via blob URLs and links all 3 verdict docs (54 measured assertions) + 23 committed screenshots. wrangler.jsonc (feat-013 KV IDs) deliberately left out. PR recorded on all three features in the brain.
- branch: `feat/qr-first-pairing-console`
- in-progress feature: none
- run note: none
- next: CI + Greptile bot pass on PR #8, then squash-merge (repo convention). feat-013 live-weather is unblocked: KV namespaces provisioned, plan approved.

---

## 2026-07-29 — PR opened for pairing-experience-redesign: https://github.com/SeanningTatum/flappyboard/pull/8
- branch: `feat/qr-first-pairing-console`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — PR opened for controller-board-mirror: https://github.com/SeanningTatum/flappyboard/pull/8
- branch: `feat/qr-first-pairing-console`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — PR opened for qr-first-tv-link: https://github.com/SeanningTatum/flappyboard/pull/8
- branch: `feat/qr-first-pairing-console`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — Shipped THREE features in one session on main. feat-014 qr-first-tv-link: /tv defaults to a QR encoding /link?code=, requireSession preserves the gated URL as validated ?next= (login+sign-up thread it), /link creates+names a board inline with rollback-safe create-and-approve (verification caught the orphan), success hands off to the controller. feat-015 controller-board-mirror: BoardGridView variant=inline (container-sized, silent) in a collapsible section on the controller — the phone shows the live board, TV path byte-untouched. feat-016 pairing-experience-redesign (refero-guided, direct build, extend-the-hardware-aesthetic): /tv and /link brought onto the console system (pilot lamp, plate QR, readout code, ConsoleField shared, SegmentTrack with pure :checked CSS reveal, ink keys, amber outline focus, color-scheme/theme-color metas); login deliberately left light. Verification found+fixed two real defects before ship: non-atomic create (orphan board) and a dead focus ring (inline box-shadow vs ring utility -> outline). Gates: typecheck 0, 1201 tests, build 0, e2e 2/2, harness 7/7, brain check clean. Verdict docs: qr-first-tv-link/verifications/2026-07-29.md (17+2), controller-board-mirror/verifications/2026-07-29.md (11), pairing-experience-redesign/verifications/2026-07-29.md (26+5). All UNCOMMITTED on main.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Commit the three-feature delta (reviewer should look at link.tsx/tv.tsx/console.tsx + locales). Then feat-013 live-weather remains the only planned feature (blocked on owner wrangler kv namespace create). Still-open owner calls from the TV trio: wedged-socket invisibility, revoke-all dead rows, TV power-cycle cookie survival.

---

## 2026-07-29 — shipped pairing-experience-redesign: Browser-verified PASS (.brain/features/pairing-experience-redesign/verifications/2026-07-29.md, 26 assertions + 5 re-che
- branch: `main`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — shipped controller-board-mirror: Browser-verified PASS (.brain/features/controller-board-mirror/verifications/2026-07-29.md, 11 assertions, walk run 3x):
- branch: `main`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — shipped qr-first-tv-link: Browser-verified PASS (.brain/features/qr-first-tv-link/verifications/2026-07-29.md, 17 assertions + 2-addendum): TV QR 
- branch: `main`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — feat-014 qr-first-tv-link verified PASS: QR→login round-trip→inline create+name→TV flip (144 tiles, fb_device cookie)→controller; E1 open-redirect dropped, E2 bogus code rejected. Finding: create-and-approve non-atomic (orphan board on bogus code).
- branch: `main`
- in-progress feature: none
- run note: none
- next: Parent to review finding + brain ship qr-first-tv-link

---

## 2026-07-29 — Shipped feat-012 kiosk-display — the TV living-room trio (010/011/012) is now fully shipped. The first kiosk walk measured a real defect: the watchdog's one-shot reload looped because the latch was a useRef that window.location.reload() resets (second reload at +121s). Fixed with createReloadLatch in kiosk.ts — sessionStorage-backed, one reload per outage, cleared on socket-live (re-arms), unreadable storage degrades to NO reload. Walk 2 PASS on the previously failing claim: no second reload across a 300s window, then a second outage re-armed the latch (+152s). Regression with drift active green: 144 tiles, 24x6, scrollable=false, drift tick at exactly 240.1s. Samsung-browser setup recipe written (recipes/samsung-tv-setup.md). Gate: typecheck 0, 1191 tests, build 0, e2e 2/2, harness 7/7, brain check clean. Uncommitted on worktree-tv-living-room (branch ahead 9 + this delta).
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: Commit the kiosk delta, then feat-013 live-weather is unblocked (010/011/012 all shipped+verified). Owner calls queued: (1) wedged-socket invisibility — heartbeat vs doc-scope; (2) revoke-all leaves dead rows in the owner device list; (3) owner-only hardware tests — 8h soak, TV power-cycle cookie survival

---

## 2026-07-29 — shipped kiosk-display: Browser walk PASS (verifications/2026-07-29.md, two walks): 144 tiles / 24x6 / scrollable=false WITH drift active, drift
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — Kickoff: feat-012 kiosk-display closeout. family-grants committed as fd8d654 (pre-commit gate green). kiosk code was complete since 2026-07-28; what it owes is the drift-on regression walk (144 tiles / 24x6 / scrollable=false), the one-shot watchdog reload proof, and the Samsung-browser setup recipe. Soak + real TV stay owner-only.
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: Browser-verification walk on the display route, write recipes/samsung-tv-browser setup doc, then ship with the soak flagged

---

## 2026-07-29 — Shipped feat-011 family-grants. The 2026-07-28 walk's finding 1 (device naming half-implemented, decision 4 unreachable) closed with the owner-ratified post-pairing offer: claim returns deviceName, DeviceNamePrompt on the controller for unnamed grant phones, nameDevice mutation names the caller's own grant by nonce (never on the wire), decideName keeps touch invariants (tombstones unresurrectable, unknown nonce creates the record for grandfathered phones). Second browser walk PASS on all 5 measured claims including the kill shot — un-pairing the row selected BY ITS NAME gave that phone 401+rescan while the sibling kept writing 200. Gate: typecheck 0, 1185 tests (+19), build 0, e2e 2/2 (first run's auth-spec failure was flake, green on re-run), harness 7/7. Also today: flappyboard-preview bootstrapped with a real wrangler deploy (v221570c8) — Deploy preview should be green on future PRs. OPEN owner calls: (1) revoke-all leaves dead phones' rows in the owner list — should the list say so? (2) the decisive tv-pairing test is still owner-only: power-cycle the real Samsung TV, confirm fb_device survives. All work UNCOMMITTED on worktree-tv-living-room (branch also 8 ahead of origin).
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: Commit + push the family-grants delta, then feat-012 kiosk-display (last of the TV living-room trio); feat-013 live-weather unblocks once 010/011/012 are all verified

---

## 2026-07-29 — shipped family-grants: Two browser walks PASS: verifications/2026-07-28.md (30-day TTL measured from the signed payload, per-device revoke isol
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — Kickoff: close family-grants verification finding 1 — wire the post-pairing device-name offer so 'un-pair Kai's phone' is reachable from the UI. Design ratified by owner: phone pairs as today, claim returns deviceName (in-flight change), an unnamed phone gets an optional prompt, new mutation names the caller's grant record by nonce. Baseline green: typecheck 0, 1166 tests.
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: Implement nameGrant (DO + service), board.nameDevice mutation, controller UI prompt; then unit tests, browser walk, ship feat-011

---

## 2026-07-29 — shipped tv-pairing: Browser-verified PASS across TWO independent worker runs that agreed on every step; verdict doc .brain/features/tv-pairi
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none

---

## 2026-07-29 — Live-weather plan fully approved (round 2). Decision 6: cache in a NEW KV binding. Decision 7: round location to ~10km with a place-name fallback on refusal. All 7 decisions now answered; feat-013 evidence updated. Recorded the consequence the KV choice inherits, because this repo already has the scar: feat-003 file-upload is shipped-but-broken since setup never provisioned R2, and the way it broke is the lesson — a merged Effect layer constructs EVERY member, so one absent binding surfaced as 'Failed to construct AuthApi' and 500'd every request in the app including routes that never touch R2. So the weather service must be provided ad-hoc in the generate path (like upload-file.ts does BucketLive and transcribe.ts does TranscriptionLive), NOT added to makeAppRuntime. Also noted that recipes/add-cf-binding step 5 still says 'provide layer -> app/runtime.ts', which is pre-R2 advice, and should gain a pointer to rules/services.md so the next person does not follow it into the same hole. Two new tests added for that specific regression: with CACHE absent the weather route degrades to the honest-unavailable board while every OTHER route still works, and the build asserts kv_namespaces present in BOTH envs of the emitted wrangler.json (same check the BOARD binding got in the split-flap-board verification).
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: OWNER-ONLY and blocking phase 4b: 'wrangler kv namespace create' — real Cloudflare credentials, creates a real resource, cannot run from CI or from an agent. Then declare kv_namespaces in BOTH the default and env.preview blocks of wrangler.jsonc (the file's own comment notes the list is identical there; a namespace added only to the default env leaves every PR preview on the binding-absent path) and run bun run cf-typegen. Still ahead of that in the queue per decision 5: verify feat-010/011/012, which are code-complete and owe browser walks. Also still owner-only from earlier: 'bun run deploy:preview' to turn Deploy preview green, and the Samsung TV walk.

---

## 2026-07-29 — Live-weather plan reviewed round 1 (plans/2026-07-28-live-weather.html); registered feat-013 live-weather as planned. Root cause established against the API reference rather than guessed: web_search has NO freshness or cache parameter (only max_uses, allowed/blocked_domains, user_location), web_fetch can only fetch URLs already present in the conversation so it is not a crawler and could never have helped, and prompt caching caches our prompt prefix and never touched search results. The staleness is structural — an index returns what the crawler saw, so sunset is right (static all day), scores and news are right (stop changing once published), and temperature is 6-10C wrong (changes hourly). Five decisions answered as recommended: third router route with pre-fetched data (no tool loop, model cannot pick the location), Open-Meteo geocoding rather than model-emitted coordinates (a model inventing lat/lon is a model inventing numbers), an honest 'unavailable' board on failure rather than falling back to search, current conditions only, and build it AFTER feat-010/011/012 are verified. Two new requirements added, each with an open decision: a day-long cache (decision 6 — where it lives; note this project has NO KV binding today, and a per-city DO via idFromName('weather:'+lat+','+lon) is the zero-new-binding alternative with precedent from feat-010's device codes) and location inferred from the phone (decision 7 — precision and refusal behaviour).
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: CORRECTION RECORDED, do not lose it: 'cache the entire 24 hours' as literally stated would cache ONE current reading for a day and put a day-old temperature on the board — worse than the few-hours-stale search snippets being removed, i.e. it would reintroduce the exact bug. The plan instead caches the day's HOURLY SERIES and reads the bucket matching the current hour: one fetch per city per day, still hour-accurate, ~1C mid-hour drift against the 6-10C being fixed. Geocoding caches separately and indefinitely since coordinates do not change. Before any code: answer decisions 6 and 7. Then decision 5 gates the work behind feat-010/011/012 verification — three features are code-complete and owe browser walks, and the Samsung TV walk plus 'bun run deploy:preview' are still owner-only.

---

## 2026-07-28 — feat-010/011/012 in flight on branch worktree-tv-living-room. Plan's one OPEN question is now answered by the owner: an unapproved device code lives in a per-code Durable Object instance addressed by idFromName('code:'+CODE) (not a global codes DO, not board-scoped-from-birth), and the device grant TTL is 180 days sliding. DONE so far: pairing.ts carries two new token families (fbd1 device grant, fbh1 single-use handoff) with deviceEpoch as a separately-named field so the two epochs cannot be swapped by mistake (98 tests); DEFAULT_GRANT_TTL_SECONDS raised 12h -> 30d; new pure modules device-code.ts (50 tests), paired-devices.ts (74 tests), kiosk.ts (22 tests); board deviceEpoch column + migration 0003 + bumpDeviceEpoch repo method; BoardRoom DO gained device-code issue/watch/approve and grants record/touch/revoke/list, with a DEVICE_CODE_TAG so a waiting TV socket can never be handed a board frame; board-room service + 6 new tRPC procedures (issueDeviceCode, approveDeviceCode, display, claimHandoff, pairedDevices, revokeDevice, revokeDevices); new routes /tv, /tv/claim, /link, /api/tv-ws; display.tsx now session-OR-device-grant and redirects a cookie-evicted TV to /tv instead of 404; board-ws.ts accepts the device grant and slides both grant families on upgrade, re-minting with the ORIGINAL nonce so per-device revoke keeps naming the same device. Typecheck 0 throughout.
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: Remaining: (1) the /boards paired-devices UI (list + per-device un-pair + un-pair-all-TVs) — its sub-agent died on the org monthly spend limit, so it is unwritten; (2) DO-level tests for the new room endpoints; (3) brain docs (three feature MDs, rules/routes, rules/repository, security.md, data-models.md, CHANGELOG) ; (4) full verify-done + feature-verifier browser walk; (5) PR via /create-pr-with-review. DEVIATION to flag in review: the plan's '~5 attempts then the code is burned' per-code counter cannot work in the per-code-DO shape (a wrong guess resolves to a different, empty room and never touches the real code's storage), so brute force is bounded instead by a new DEFAULT_QUOTA['approve-device'] fixed window of 8/hour per owner and 16/hour per board.

---

## 2026-07-28 — PR #5 merged. Squash-merged to main as e04b427 and Deploy Production succeeded on it, so the spend caps are live in production and issue #1 is closed for real. Verified on origin/main rather than assumed: app/lib/board/quota.ts and its 37-test suite are present, workers/board-room.ts carries handleSpendQuota reading DEFAULT_QUOTA[spend.endpoint] (the DO owns the policy), /api/transcribe has both the peek and the charge call sites, and RateLimitError appears twice in effect-trpc.ts (the APP_ERROR_TAGS entry plus the TOO_MANY_REQUESTS case). Note the merge commit c20424b is NOT an ancestor of main — this repo squash-merges, same as PR #2 (f8ae90f) and PR #3 (2157222), so that is expected and not a lost merge. Final gate before merge: typecheck 0, 930 tests, build 0, harness 7/7, all four CI jobs green. Deploy preview stayed red as documented.
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: OWNER-ONLY, still the only red thing in CI: run 'bun run deploy:preview' once locally to bootstrap the preview worker — needs real Cloudflare credentials and creates real resources, so neither CI nor an agent can do it. DECISION OWED, flagged in the feature doc and not acted on: the 20 generations/hour cap was chosen when a generation was 1-3 Sonnet calls at max_tokens 4096; after PR #4 it is a Haiku router call plus 1-3 Sonnet attempts at 8192 plus a billed web search plus up to 3 pause_turn resends that do not spend a retry attempt, so the dollar ceiling the cap permits is materially higher than when the number was set. Lowering DEFAULT_QUOTA is the whole change if you want it tighter. Then feat-010 tv-pairing per the plan's decision 6.

---

## 2026-07-28 — CI triage. Three separate things, only one mine. (1) PR #5 showed ZERO checks — not a broken pipeline: the branch had gone CONFLICTING when v0.1.1 (PR #3, README trim) landed on main, and GitHub will not run pull_request workflows on a PR whose merge commit it cannot compute. 'gh pr checks' reports 'no checks reported', which reads like none-configured rather than none-possible; the tell is 'gh pr view --json mergeable' = CONFLICTING. Merged origin/main in (not rebased — branch is pushed with an open PR), resolved .brain/CHANGELOG.md and .brain/runs/progress.md by keeping every entry from both sides in date order (all 9 of the day's checkpoints survive; no code conflicted), and corrected a stale 903 -> 908 test count in my own CHANGELOG entry. PR #5 is now MERGEABLE and all four CI jobs PASS: Baseline, Build, E2E smoke, Five non-negotiables sweep. (2) PR #4 feat/board-agent-web-search failed its non-negotiables sweep on a bare 'throw new Error("needs_live_data was not a boolean")' at commit 153671b — already fixed by that branch's owner at 5eee9bc, where the sweep is green. Left alone, not mine to push to. (3) Deploy preview is red on EVERY PR and is the only real standing failure: 'Could not extract preview URLs from wrangler output'. The version uploads fine and the code-10211 Durable Object branch does not fire — flappyboard-preview has simply never had a real wrangler deploy, so preview URLs were never enabled and there is nothing to extract. Confirmed NOT caused by the spend-cap change.
- branch: `worktree-tv-living-room`
- in-progress feature: llm-board-agent
- run note: none
- next: OWNER-ONLY, one-time, and the only thing still red: run 'bun run deploy:preview' locally to bootstrap the preview worker. It needs real Cloudflare credentials and creates real resources, so it cannot run from CI or from here — preview.yml:181 documents the same remedy. That turns Deploy preview green for every future PR until a new DO migration tag is added. PR #5 is otherwise green and mergeable. After it merges: feat-010 tv-pairing per the plan's decision 6.

---

## 2026-07-28 — Issue #1 shipped as PR #5 (https://github.com/SeanningTatum/flappyboard/pull/5) through the pre-PR review flow: verify -> review -> resolve -> create. Greptile ran clean this time (it deterministically timed out on the MVP's ~50-file diff) at confidence 3/5 with 4 findings — 2 P1 escalated and answered by the owner, 2 P2 auto-fixed. P1a: the DO enforced caller-supplied limits, so the cap was a call-site convention; policy moved into the DO, wire shrunk to endpoint/spender/mode, and a test asserts a limit cannot be smuggled. P1b: quota was charged before readBoundedBody, so oversized chunked bodies drained the board budget at zero AI cost; now peek -> read -> charge, re-measured closed (10 oversized chunked posts -> 413 x10, zero allowance consumed, a full 60 tiny posts still fit). A 5th finding came from the browser, not from static review: three runs agreed a cap refusal rendered the generic 'The board didn't take it' because the component discarded the error payload — retryAfter never reached the phone despite RateLimitError's doc comment promising it would. Needed cause: e on the TRPCError plus an allowlisted errorFormatter line; three runs then confirmed 1210s->'21 minutes', 627s->'11 minutes', 578s->'10 minutes', with C and D proving the 429 came from board.generate while /api/transcribe returned 200. Gate: typecheck 0, 908 tests (from 849), build 0, e2e 2/2, harness 7/7.
- branch: `worktree-tv-living-room`
- in-progress feature: llm-board-agent
- run note: none
- next: Owner-only and now unblocked: deploy with a real ANTHROPIC_API_KEY. Then feat-010 tv-pairing per the plan's decision 6 — its device-code endpoint inherits this limiter, which was its hard prerequisite since a 6-char code is only safe while attempt-capped. Still owed on real hardware: the Samsung TV walk and phone voice over HTTPS. Still unproven: /api/transcribe's 429 through the UI, fail-closed against a genuinely broken DO, and window rollover.

---

## 2026-07-28 — PR opened for llm-board-agent: https://github.com/SeanningTatum/flappyboard/pull/5
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none

---

## 2026-07-28 — shipped llm-board-agent: Shipped in v0.1.0 (PR #2, squash-merged as f8ae90f, 2026-07-27) and held open afterwards only for a formal verdict doc a
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none

---

## 2026-07-28 — Issue #1 closed — spend caps on board.generate and /api/transcribe, committed as abd0eea on worktree-tv-living-room. Atomic per-spender + per-board check-and-increment in the BoardRoom Durable Object (no new binding; same blockConcurrencyWhile as the spent-nonce ledger), new RateLimitError -> TOO_MANY_REQUESTS, 429 + Retry-After on the non-tRPC transcribe route. Gate: typecheck 0, 892 tests (from 849), build 0, e2e 2/2, harness 7/7. Four claims proven live against a real DO, not reasoned about: cap bites at 21 with a usable retryAfter; 30 concurrent calls at a limit of 20 admitted exactly 20 (no lost increments — the reason it lives in the DO); an exhausted owner still left a freshly paired grant its own full 20; and a 4th grant with a brand-new nonce was refused on its first call at 60/60, closing the re-pairing bypass. Verdict doc at .brain/features/llm-board-agent/verifications/2026-07-28.md, deliberately scoped — it says the endpoints are bounded, NOT that the LLM feature works. Also fixed a recipe trap: effect-trpc gates on a runtime APP_ERROR_TAGS set that nothing type-checks against the AppError union, so a new error compiles fine and still returns a generic 500; recipes/add-tagged-error.md now names that step.
- branch: `worktree-tv-living-room`
- in-progress feature: llm-board-agent
- run note: features/llm-board-agent/runs/2026-07-28-progress.md
- next: feat-009 stays in-progress: it still owes a browser walk of the actual voice-to-board golden path, which needs ANTHROPIC_API_KEY and the remote AI binding — owner-only. Also unproven: /api/transcribe's 429 (same spendQuota call and ledger, but reaching it needs the AI binding) and fail-closed against a live broken DO (unit-tested at the service boundary only). Once feat-009 has that verdict, decision 6 releases the TV living-room work and phase 1 (feat-010 tv-pairing) starts — its device-code endpoint inherits this limiter.

---

## 2026-07-28 — Kickoff: issue #1 rate limiting / spend caps on board.generate and /api/transcribe — Phase 0 of the TV living-room plan and the last hard blocker on a real-key deploy. Domain: mixed (cloudflare DO + routes + errors). Scope: both. Affects feat-009 llm-board-agent, the one in-progress feature, so no scope-policy conflict. Runbook: recipes/add-tagged-error (whose worked example is literally a RateLimitError) plus rules/cloudflare for the DO side. Baseline green after 'bun install' in the worktree — the first run's TS2742 on app/trpc/client.tsx was an empty-node_modules artifact of the fresh worktree, not a regression.
- branch: `worktree-tv-living-room`
- in-progress feature: llm-board-agent
- run note: features/llm-board-agent/runs/2026-07-28-progress.md
- next: Mirror workers/board-room.ts handleSpendNonce (line 203) into a quota counter: atomic check-and-increment under blockConcurrencyWhile, windowed, keyed by grant nonce so one guest cannot spend another's allowance, with a prune companion like pruneNonces (line 252). First check whether BoardAccess already carries the grant nonce — it exposes via/grantIssuedAt/grantExpiresAt, and if the nonce is not on it, that has to be surfaced before the counter can be keyed correctly.

---

## 2026-07-28 — TV living-room plan reviewed and approved (round 1, plans/2026-07-28-tv-living-room.html). All 6 decisions answered: device-code pairing for the TV (/tv + /link, WebSocket approval not polling); runtime is the Samsung BUILT-IN BROWSER, chosen against the recommendation of a kiosk stick — no native Tizen/webOS app either way; 30-day sliding controller grants (up from 12h); device name captured at pairing, owner-visible; pixel drift + idle dim for burn-in; and feat-009 llm-board-agent gets closed out FIRST rather than being parked blocked. Three open questions resolved in review (socket over polling, one board for now, spinner while offline); one still open — where an unapproved device code lives before it is bound to a board. Registered feat-010 tv-pairing, feat-011 family-grants, feat-012 kiosk-display as planned with feature docs. Working in git worktree .claude/worktrees/tv-living-room on branch worktree-tv-living-room, based on merged main (v0.1.0). No app code touched yet.
- branch: `worktree-tv-living-room`
- in-progress feature: none
- run note: none
- next: Decision 6 governs the order: close feat-009 llm-board-agent first — it needs a browser-level verdict doc, and its issue #1 (rate limiting / spend caps on board.generate and /api/transcribe) is ALSO a hard prerequisite for feat-010, since a 6-char device code is only safe when attempt-capped. Then phase 1 (feat-010 tv-pairing). Two owner-only tests are decisive and cannot be faked in CI: power-cycle the real Samsung TV to see whether the fb_device_ cookie survives (if it does not, decision 2 is wrong and the runtime must be revisited), and drive voice on a real phone over HTTPS.
## 2026-07-28 — PR #4 extended with routing and retitled 'live data via a routed web search' (4 commits). Three findings, all measured: max_uses 1 STARVES the search when dynamic filtering is on (single use spent inside the code-execution path, model writes LIVE FEED UNAVAILABLE / SEARCH TOOL OFFLINE — seen at 73s and 41s), so allowed_callers direct and a cap of 1 go together or not at all; direct search halves the searching path to 15.3s on ~14k input tokens vs 30-35s/~22k filtered; and direct search alone leaks the do-not-search rule (5 of 6 plain prompts searched, a reminder going 3s to 9s). So Haiku 4.5 now answers one structured-output boolean and the answer decides whether tools is attached at all — omitted, not empty. Router fails OPEN to searching on every unhappy path, and the no-search path gets its own prompt so a request that cannot search is not told to search. Sonnet still writes every board: running the board on Haiku was measured (16.5s vs 14.5s, worse layout) and rejected, as was removing thinking (already 0 thinking tokens; documented to make the model less tool-eager). Measured: weather 15.3s, match result 9.6s, reminder 3.5s, greeting 3.3s. 863 tests green (14 new hermetic), typecheck/build clean, harness 7/7, Greptile 0 comments confidence 5/5 on three separate passes.
- branch: `feat/board-agent-web-search`
- in-progress feature: none
- run note: none
- next: Owner decides the merge. IMPORTANT correction now recorded in the feature memo and the PR body: web search returns SOURCED figures, not CURRENT ones — against Open-Meteo every config was materially stale on temperature (filtered re-measure 14C vs real 24.4C, direct 17C vs 24.4C, run C 22C vs 16C, run E 19-22C vs 23.3C). The earlier verification docs and the original PR body overstated this as 'real numbers'. Search is right for discrete facts (the Liverpool 4-2 Sunderland board was specific and checkable) and wrong for a live sensor reading; adding web_fetch did not help because the model never called it. If accurate weather matters the real fix is a weather API as its own tool (Open-Meteo, no key needed) — not more search tuning. Still blocking a real-key deploy: issue #1 rate limiting / spend caps. Router accuracy is 4/4 end to end plus a six-prompt probe — small sample, but it fails open so the downside is cost not correctness. The two browser walks predate the routing commit; routing is covered by unit tests plus service-level measurement, not a third walk.

---

## 2026-07-28 — Web search shipped to PR #4 (https://github.com/SeanningTatum/flappyboard/pull/4) on branch feat/board-agent-web-search — 3 commits: the service change, the verification evidence, and the feature-memo link. Greptile reviewed the branch twice pre-PR (code diff, then final diff): 0 comments, confidence 5/5, no security findings, so nothing needed triaging. Two independent browser runs agree that a live-data prompt lands real numbers and a plain prompt does not search: run C got a sunset within one minute of reality (30.5s searching vs 5.3s not), run E got sky matching the WMO code and a humidity range containing the real 38% (35.1s vs 12.9s). 855 unit tests green (6 new, hermetic), typecheck and build clean, harness-check 7/7.
- branch: `feat/board-agent-web-search`
- in-progress feature: none
- run note: none
- next: Merge decision is the owner's. Before a real-key deploy, land issue #1 (rate limiting / spend caps on board.generate and /api/transcribe) — web search bills per search on top of ~18k input tokens per searched turn, so this PR turns that from should-have into blocker. Then pick a latency affordance: ~30-35s searching vs ~5-13s not is a long time at a blank TV, and the untaken levers are max_uses 2, response_inclusion 'excluded', or a searching state on the controller. feat-009 stays in-progress: still outstanding are voice on a real phone over HTTPS and a walk on the actual Samsung TV. Two harness traps are now written down in the feature memo so they are not rediscovered as app bugs — TV screenshots within ~5s of a write catch tiles mid-flap, and control-ptt needs dispatched PointerEvents rather than page.mouse on a hasTouch context.

---

## 2026-07-28 — v0.1.1 released — docs-only patch. PR #3 squash-merged as 2157222 and tagged v0.1.1 (https://github.com/SeanningTatum/flappyboard/releases/tag/v0.1.1). README trimmed 275 -> 244 lines: the harness-loop.gif embed removed and harness-loop.gif + harness-loop.mp4 deleted (995KB, both boilerplate leftovers from the initial commit 80e73a8 and the only docs/assets files not from this project's own verification walks); 'Four ideas worth stealing' collapsed into four bullets under 'How it's built' with all technical claims intact; the verification section's brag paragraph and the flap-travel rAF aside cut. setup-flow.svg deliberately kept. Deploy preview red again for the same non-code reason (version 93a23ae5 uploaded, preview-URL extraction failed); Baseline/Build/E2E/sweep green.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Owner-only, one-time: run 'bun run deploy:preview' locally to bootstrap the preview worker — turns Deploy preview green for every future PR. Still blocking a real-key deploy: issue #1 (rate limiting / spend caps on board.generate and /api/transcribe). Still outstanding: drive voice on a real phone over HTTPS, walk the display on the actual Samsung TV. feat-009 (llm-board-agent) stays in-progress until it has a browser-level verdict doc. NOTE: uncommitted in-flight work sitting in the working tree on app/services/board-agent.ts + its test (web_search_20260318 tooling, pause_turn handling, trailing-text extraction) — not part of v0.1.1, not committed.

---

## 2026-07-28 — Web search enabled on the board agent (feat-009). board.generate now declares the server-side web_search_20260318 tool with max_uses 3, so live-data prompts land real numbers on the board. Compatibility with structured outputs was verified against the live API first, not assumed — the docs are silent on it. Response handling changed in three places: textOf now reads only the trailing text run (a searching response interleaves tool blocks and the model may narrate first), pause_turn is resent unchanged without spending a retry attempt, and retries echo response.content verbatim so encrypted search results and thinking blocks survive instead of triggering a second search. max_tokens 4096 to 8192. Live end-to-end: 'weather in oslo' rendered a correct 4-row board in one attempt (~31s, two searches); 'bin day is thursday' correctly skipped search (~10s). Typecheck clean, 855 unit tests green (6 new).
- branch: `main`
- in-progress feature: none
- run note: none
- next: Two things this opens up. (1) Latency: the search path measured ~31s vs ~10s without — that is a long time to hold a phone in front of a blank TV, so consider dropping max_uses to 2, setting response_inclusion 'excluded', or showing a searching state on the controller. (2) Cost: web search bills per search on top of tokens, and a searched turn ran ~18k input tokens, which sharpens issue #1 (rate limiting / spend caps on board.generate and /api/transcribe) from a should-have to a blocker for any real-key deploy. Also still outstanding from before: owner-only 'bun run deploy:preview' to bootstrap the preview worker, drive voice on a real phone over HTTPS, walk the display on the Samsung TV, and get feat-009 a browser-level verdict doc.

---

## 2026-07-28 — v0.1.0 released. PR #2 squash-merged to main as f8ae90f and tagged v0.1.0 (https://github.com/SeanningTatum/flappyboard/releases/tag/v0.1.0) — first tag on the repo. README rewritten from the starter boilerplate into a flappyboard product page with six real screenshots reused from the verification walks plus one watermarked setup mockup. Merged with Deploy preview red, knowingly: the worker version uploads fine, the job dies extracting a preview URL because flappyboard-preview has never had a real wrangler deploy so preview URLs are not enabled on it. Baseline/Build/E2E/sweep all green.
- branch: `main`
- in-progress feature: none
- run note: none
- next: Owner-only, one-time: run 'bun run deploy:preview' locally to bootstrap the preview worker — that turns Deploy preview green for every future PR. Still blocking a real-key deploy: issue #1 (rate limiting / spend caps on board.generate and /api/transcribe). Still outstanding: drive voice on a real phone over HTTPS, walk the display on the actual Samsung TV. feat-009 stays in-progress until it has a browser-level verdict doc.

---

## 2026-07-27 — flappyboard MVP shipped as PR #2 (https://github.com/SeanningTatum/flappyboard/pull/2). 12 commits, 849 tests across 44 files, typecheck 0, build 0, harness 7/7. Three browser verification runs: two independent walks agreed 7/7 each, plus a third re-verifying scan-to-pair and revoke after the grantEpoch HMAC change. Pre-PR review: Greptile could not run (deterministic 30s API timeouts on a ~50-file diff), substituted by effect-ts-enforcer + an adversarial security pass; all 13 actionable findings fixed in 245c888, including revocable controller grants, production stack traces, a 100MB unbounded body, and a board-existence oracle.
- branch: `feat/flappyboard-mvp`
- in-progress feature: none
- run note: none
- next: Blocking before any deploy with a real key: issue #1 (rate limiting / spend caps on board.generate and /api/transcribe). Owner-only tasks: drive voice on a real phone over HTTPS (mediaDevices needs a secure context) and walk the display on the actual Samsung TV. feat-009 deliberately left in-progress until it has a browser-level verdict doc.

---

## 2026-07-27 — PR opened for llm-board-agent: https://github.com/SeanningTatum/flappyboard/pull/2
- branch: `feat/flappyboard-mvp`
- in-progress feature: none
- run note: none

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
