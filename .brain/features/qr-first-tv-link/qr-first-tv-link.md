# Feature: QR-First TV Link

_Last updated: 2026-07-29_

**Status: shipped 2026-07-29.** Browser-verified PASS (17 assertions, golden
path + 2 error paths) plus a rollback-fix addendum (2 more):
[`verifications/2026-07-29.md`](verifications/2026-07-29.md). Builds on feat-010
tv-pairing; the device-code protocol is unchanged.

## Purpose
Make the QR code the default way to link a TV. `/tv` shows a QR encoding
`/link?code=<CODE>` (typed 6-char code stays as a smaller fallback); a phone
that scans it is sent through login (or sign-up) and returned to `/link` with
the code prefilled, where it can **create and name a board inline** and pair the
TV in one submit. Success hands off to the controller.

## When It's Used
- A TV (or any display) opens `/tv` unpaired → QR on screen
- Owner scans → not signed in → `/login?next=/link?code=…` → back to `/link`
- Owner names a new board (or picks an existing one) → TV flips to the board
- Success screen offers "Open the controller" → `/b/:boardId/c`

## How It Works
- `/tv` loader returns `linkUrl` = `tvLinkUrl(request.url, code)` (pure, unit
  tested; absolute, request-origin based, rotates with the code). A `TvQr`
  component (`qrcode` package, same recipe as `qr-overlay.tsx`) renders it at
  38vmin with the encoded URL on `data-link-url` for tests. Socket, rotation,
  and `/tv/claim` logic untouched.
- `app/lib/session.ts`: `requireSession` redirects to `/login?next=<path+query>`
  via `loginRedirectUrl`; `safeNextPath` validates `next` (same-origin absolute
  paths only — rejects `//host`, scheme URLs, empties). Login and sign-up thread
  `next` through loaders (`redirectIfAuthenticated` honors it) and forms
  (`navigate(next ?? "/dashboard")`, cross-links carry it).
- `/link` loader does a manual session check (anonymous → `loginRedirectUrl`
  preserving `?code=`) and prefills the code via `normalizeDeviceCode`. Action:
  `intent=new` → `normalizeBoardName`/`isValidBoardName` → `board.create` →
  `approveDeviceCode`; `intent=existing` unchanged. **Create-and-approve is
  rollback-safe**: on approve failure the just-created board is deleted
  (verification found the orphan). Success returns `{name, boardId}` and the
  submit button is replaced by "Open the controller".

### Testability
Unit: `safeNextPath`/`loginRedirectUrl` matrix (15 tests in
`app/lib/__tests__/session.test.ts`); `tvLinkUrl` (3 tests in
`app/routes/__tests__/tv.test.ts`). e2e auth spec asserts the `?next=`
round-trip. Browser walk: two isolated contexts (TV + zero-cookie phone) —
QR encodes `/link?code=`, login round-trip preserves the code, create+name
pairs the TV (144 flap tiles, `fb_device_<boardId>` HttpOnly cookie, no
reload), `?next=//evil.com` never leaves origin, bogus code refused; addendum:
bogus code leaves no orphan board, success hides submit.

## Key Files

| File | Role |
|------|------|
| `app/routes/tv.tsx` | QR-first pairing screen (loader `linkUrl` + TvQr) |
| `app/routes/link.tsx` | Owner side: prefill, create-and-approve + rollback, success → controller |
| `app/lib/session.ts` | `safeNextPath`, `loginRedirectUrl`, `requireSession` next-param |
| `app/routes/authentication/login.tsx`, `sign-up.tsx` + forms | `next` threading |
| `app/locales/{en,zh}/board.json`, `boards.json` | Copy |

## Dependencies
- feat-010 tv-pairing (device codes, `approveDeviceCode`, `/tv/claim`)
- `qrcode` package (already used by `qr-overlay.tsx`)
- `board.create`, `board.delete`, `board.approveDeviceCode` tRPC procedures

## Changelog

| Date | Type | Description |
|------|------|-------------|
| 2026-07-29 | feature | Planned from owner-approved session plan |
| 2026-07-29 | feature | Shipped — QR default on /tv, login `?next=`, name-during-link, rollback-safe create |
