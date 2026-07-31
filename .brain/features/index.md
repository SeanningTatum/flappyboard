# Features — Index

Per-feature memory. **One folder per feature** — `features/<slug>/` holds everything about that feature in one place: the memo, its browser-walk verification docs + screenshots, and any feature-specific run notes. Loaded by agents *before* touching a feature so they understand intent, existing surface, and how it was last proven to work.

## Folder shape

```
features/
├── index.md                    this file
├── _TEMPLATE.md                feature-memo template (copy to <slug>/<slug>.md)
├── _VERIFICATION_TEMPLATE.md   verification-doc template (copy to <slug>/verifications/<date>.md)
├── feature_list.json           machine-readable status registry (stays at root)
└── <slug>/
    ├── <slug>.md               the feature memo (purpose, runtime flow, key files, tagged errors, changelog)
    ├── verifications/<date>.md  feature-verifier verdicts (browser walk)
    ├── screenshots/            evidence captured by the feature-verifier
    └── runs/<date>-<slug>.md   feature-specific run notes (hybrid — see below)
```

> **Hybrid runs.** Feature-specific run notes live in `<slug>/runs/`. The global rolling cursor [`../runs/progress.md`](../runs/index.md) and cross-cutting task notes (harness changes, multi-feature refactors) stay in [`.brain/runs/`](../runs/index.md).

## When to read

- About to modify a feature → read `<slug>/<slug>.md` first, then its latest `verifications/` doc for known-good behavior
- Deciding scope of a new feature → check for adjacent features that overlap
- Investigating a bug → confirm expected behavior matches the memo + last verification

## When to write

- New feature ships → create `<slug>/<slug>.md` (from `_TEMPLATE.md`) in the same PR
- Bugfix that changes runtime behavior → append to the feature's changelog table
- User-visible flow verified → `feature-verifier` writes `<slug>/verifications/<date>.md` + screenshots
- Feature ripped out → **delete the whole `<slug>/` folder** (never leave stale memory)

## Conventions

- Folder + memo filename: `kebab-case` (e.g. `file-upload/file-upload.md`)
- `_Last updated: YYYY-MM-DD_` at top of the memo — refresh on every edit
- `Key Files` table in the memo = source of truth for what code belongs to the feature
- `Changelog` table appends newest entry on top
- Register the feature in the table below **and** in `feature_list.json`

## Files

| Feature | Memo | Status | Latest verification |
|---------|------|--------|---------------------|
| Authentication | [`authentication/authentication.md`](authentication/authentication.md) | shipped | [2026-07-13 ✅ PASS](authentication/verifications/2026-07-13.md) |
| Admin Dashboard | [`admin-dashboard/admin-dashboard.md`](admin-dashboard/admin-dashboard.md) | shipped | — |
| File Upload | [`file-upload/file-upload.md`](file-upload/file-upload.md) | shipped | — |
| Analytics | [`analytics/analytics.md`](analytics/analytics.md) | shipped | — |
| Preview Deployments | [`preview-deployments/preview-deployments.md`](preview-deployments/preview-deployments.md) | shipped | — |
| Feature Verification | [`feature-verification/feature-verification.md`](feature-verification/feature-verification.md) | shipped | [2026-07-13 ✅ PASS (self-verified via authentication)](authentication/verifications/2026-07-13.md) |
| Split-Flap Board | [`split-flap-board/split-flap-board.md`](split-flap-board/split-flap-board.md) | shipped | — |
| Phone Control | [`phone-control/phone-control.md`](phone-control/phone-control.md) | shipped | — |
| LLM Board Agent | [`llm-board-agent/llm-board-agent.md`](llm-board-agent/llm-board-agent.md) | shipped | — |
| TV Pairing | [`tv-pairing/tv-pairing.md`](tv-pairing/tv-pairing.md) | shipped | [2026-07-28 ✅ PASS](tv-pairing/verifications/2026-07-28.md) |
| Family Grants | [`family-grants/family-grants.md`](family-grants/family-grants.md) | shipped | [2026-07-29 ✅ PASS](family-grants/verifications/2026-07-29.md) |
| Kiosk Display | [`kiosk-display/kiosk-display.md`](kiosk-display/kiosk-display.md) | shipped | [2026-07-29 ✅ PASS](kiosk-display/verifications/2026-07-29.md) |
| QR-First TV Link | [`qr-first-tv-link/qr-first-tv-link.md`](qr-first-tv-link/qr-first-tv-link.md) | shipped | [2026-07-29 ✅ PASS](qr-first-tv-link/verifications/2026-07-29.md) |
| Controller Board Mirror | [`controller-board-mirror/controller-board-mirror.md`](controller-board-mirror/controller-board-mirror.md) | shipped | [2026-07-29 ✅ PASS](controller-board-mirror/verifications/2026-07-29.md) |
| Pairing Experience Redesign | [`pairing-experience-redesign/pairing-experience-redesign.md`](pairing-experience-redesign/pairing-experience-redesign.md) | shipped | [2026-07-29 ✅ PASS](pairing-experience-redesign/verifications/2026-07-29.md) |
| Auto TV Link | [`auto-tv-link/auto-tv-link.md`](auto-tv-link/auto-tv-link.md) | shipped | [2026-07-29 ✅ PASS](auto-tv-link/verifications/2026-07-29.md) |
| Live Weather | [`live-weather/live-weather.md`](live-weather/live-weather.md) | planned | — |
| OpenTelemetry Span Tracing | [`otel-tracing/otel-tracing.md`](otel-tracing/otel-tracing.md) | shipped (synced from template) | — (upstream-verified only) |
| Brand System | [`brand-system/brand-system.md`](brand-system/brand-system.md) | in-progress | — |

> **This table mirrors `feature_list.json`, which is the source of truth
> `brain check` enforces.** It drifted once before and stayed wrong for two
> days: six rows carried stale statuses and five shipped features were missing
> from it entirely, while the tracker was correct the whole time. If the two
> ever disagree, the tracker wins and this table is the thing to fix.

## Update trigger

Add a row when a feature folder is created; update the "Latest verification" cell when `feature-verifier` produces a new verdict; remove the row when the feature folder is deleted.
