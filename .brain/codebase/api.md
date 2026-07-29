# API Reference

## tRPC routes

Mounted at `/api/trpc/*`. The top-level router (`app/trpc/router.ts`) composes four sub-routers:

| Router | File | Procedures |
|--------|------|------------|
| `user` | `app/trpc/router.ts` | `getUsers` (protected, safe projection), `deleteUser`, `createWorkflow` |
| `board` | `app/trpc/routes/board.ts` | `create`, `list`, `get`, `rename`, `delete`, `revokeControllers`, `revokeDevices`, `pairedDevices`, `revokeDevice`, `approveDeviceCode` (**owner-only**) · `setMessage`, `history`, `updateSettings`, `generate` (owner **or** controller grant) · `nameDevice` (**controller grant only** — a phone names its own device) · `display` (owner **or** device grant) · `pair`, `claim`, `issueDeviceCode`, `claimHandoff` (**public** — the phone or the TV has no session yet) |
| `admin` | `app/trpc/routes/admin.ts` | `getUsers`, `getUser`, `updateUser`, `banUser`, `unbanUser`, `deleteUser`, `bulkBanUsers`, `bulkDeleteUsers`, `bulkUpdateUserRoles` |
| `analytics` | `app/trpc/routes/analytics.ts` | `getUserStats`, `getUserGrowth`, `getRoleDistribution`, `getVerificationDistribution`, `getRecentSignupsCount` |

Read the route files directly for current input schemas — they're authoritative.

### Board routes — four rules that are easy to break

0. **`rename` and `delete` use `requireOwnedBoard`, never `requireBoardAccess`.** The two guards are not interchangeable: `requireBoardAccess` also accepts a controller-grant cookie, so reusing it on a destructive operation would let anyone who ever scanned the QR destroy the board **and its entire snapshot history** (`board_snapshot.boardId` is `onDelete: "cascade"`). A grant authorises writing *to* a board, never destroying it. Deletion also orphans that board's Durable Object storage — harmless, since an idle DO hibernates at no cost and board ids are UUIDs, so a deleted id is never re-addressable.


1. **A board owned by someone else fails as `NotFoundError`, never `FORBIDDEN`.** A `FORBIDDEN` would confirm the id is real and make boards enumerable. `requireOwnedBoard` in `app/trpc/routes/board.ts` is the single gate; the WebSocket route `app/routes/api/board-ws.ts` applies the same rule.
2. **`get` reads live state from the `BoardRoom` Durable Object, not from the latest D1 snapshot.** The snapshot table is history; the room is truth.
3. **Writes go only through the room** (`setMessage` → DO), which compiles, assigns the revision, broadcasts, and persists. Never write a snapshot from a route — one write path is what keeps a stored snapshot from disagreeing with what the TV is showing. Note that WebSocket writes bypass tRPC entirely, so anything that must happen per-write belongs in the DO, not in a procedure.

### Pairing — how a phone with no account drives a board

Two tokens, one primitive (`app/lib/board/pairing.ts`, HMAC-SHA256 over `crypto.subtle`, keyed with `BETTER_AUTH_SECRET`):

1. **Pairing token** — minted by the display (which holds the owner's session), printed as the QR, ~120s TTL, **single-use**. Proves "the owner's screen told you about this board, just now".
2. **Controller grant** — issued when a pairing token is redeemed, carried in an `HttpOnly` per-board cookie, ~12h. Proves "you may write to board X" and nothing else.

Things that are load-bearing and easy to break:

- **Four token families share one primitive.** `fbp1` (QR pairing token, ~120s), `fbg1` (controller grant, 30 days sliding), `fbd1` (device grant for a TV, 180 days sliding) and `fbh1` (single-use handoff, ~120s). `fbp1`/`fbg1` are signed over `grantEpoch`; `fbd1`/`fbh1` over `deviceEpoch`. `fbh1` is a separate prefix rather than a reused `fbp1` **because the two are redeemed for credentials of different weight** — sharing one would let a QR photographed off the TV be walked into `/tv/claim` and cashed for the 180-day device grant.
- **The signed message is `prefix|boardId.length|boardId|epoch|payload`.** The prefix authenticates *purpose*, so a grant can never be replayed as a pairing token (it fails `malformed` before the key is consulted). The board id is a **MAC audience**, so a token for board A simply fails to verify for board B — there is no "compare the ids afterwards" step to forget. Length framing keeps the encoding injective. `grantEpoch` (a counter on the `board` row) is what makes **revocation** possible: `board.revokeControllers` increments it and every outstanding pairing token *and* grant for that board — and no other board — fails as `bad-signature`. It lives on the row, not in DO storage, so the request worker can check it off a read it already does.
- **Verify order is structure → signature → claims.** Nothing in the payload is trusted — not even enough to say "expired" — until the MAC matches.
- **Single-use is enforced in the board's Durable Object**, not in the request worker: `POST /spend-nonce` does the check-and-set inside `blockConcurrencyWhile`, so in a single-threaded per-board object exactly one of N concurrent redemptions wins. It was originally the Workers Cache API, which is per-colo, evictable, and **a no-op under `wrangler dev`** — replay protection was effectively absent locally. Do not move it back.
- **A grant is not a session.** `create`/`list`/`get`/`rename`/`delete`/`revokeControllers` stay owner-only; only `setMessage`/`generate`/`updateSettings`/`history` accept a grant, via `requireBoardAccess`. `history` is additionally floored at the grant's own `issuedAt` (`grantHistoryFloor`) — a guest reads what the board has shown since they paired, never the prompts the owner dictated before that.
- **`Path=/` on the grant cookie is deliberate** — writes go to `/api/trpc`, so a board-scoped path would send the cookie to the page and withhold it from every mutation. Scoping comes from the per-board cookie *name* plus the board id inside the MAC.
- **The QR is re-minted every ~40s** (TTL/3) by the display, on an interval plus `visibilitychange`. Without it a TV left on the wall for three minutes shows a dead code.

### Settings never bump the revision

`updateSettings` writes D1 first (durable record), then pushes the row it read back into the room, which broadcasts a `state` frame **at the same revision** and writes no snapshot row — history is a log of *grids*, and a mute is not a grid. The display's `shouldApplyState` applies equal revisions precisely so these frames land. Do not "fix" either half.

### Live board socket

`GET /api/board-ws?boardId=<id>` (resource route, `app/routes/api/board-ws.ts`) is the browser's door into a board's Durable Object — tRPC cannot carry a protocol upgrade. It authenticates, checks ownership, then returns the DO's `101` Response **untouched** (wrapping or copying it drops the socket). Non-upgrade requests get `426`. Wire protocol: [`app/lib/board/protocol.ts`](../../app/lib/board/protocol.ts).

### Example procedure (current pattern)

```typescript
// app/trpc/routes/admin.ts
export const adminRouter = createTRPCRouter({
  getUsers: adminProcedure
    .input(Schema.standardSchemaV1(GetUsersInput))
    .query(({ ctx, input }) =>
      runProcedure(
        ctx.runtime,
        Effect.gen(function* () {
          const repo = yield* UserRepository;
          return yield* repo.getUsers(input);
        })
      )
    ),
});
```

Rules:
- **Body always wrapped in `runProcedure(ctx.runtime, Effect.gen(...))`.** It runs the Effect on the per-request `ManagedRuntime` and converts tagged errors → `TRPCError` via `tagToTRPC`. `runProcedure` also maps failures from the runtime's own **layer construction** (a missing D1/R2/Workflow binding or broken Better Auth config, surfaced only via `runPromiseExit` — not part of the procedure's own error channel) through the same `toTRPC` mapping, so a broken binding produces a clean, logged 500 instead of a raw rejection.
- **Input via Effect Schema:** `Schema.standardSchemaV1(MySchema)`. Decode failures surface to clients as `TRPCError({ code: "BAD_REQUEST" })` with structured `data.schemaError` (formatted by `ParseResult.ArrayFormatter`).
- **Yield repos** (`yield* WidgetRepository`) — never call repo methods as plain functions.
- **Domain pre-conditions:** `Effect.fail(new ValidationError(...))` inside the gen — `tagToTRPC` maps to `BAD_REQUEST`.

**`user.getUsers` is now auth-gated + narrowed.** It used to be a `publicProcedure` returning full `user` rows (email, role, ban reason, verification status) with no auth check. It's now `protectedProcedure` and maps the repo result down to a safe projection — `{ id, name, image, createdAt }` — before returning. The duplicate `getUsersProtected` procedure (same body, no callers) was folded into this one rather than kept as a second surface.

### Server-side calls (loaders)

```typescript
// app/routes/admin/users.tsx
export async function loader({ request, context }: Route.LoaderArgs) {
  const session = await context.auth.api.getSession({ headers: request.headers });
  if (!session) return redirect("/login");

  const result = await context.trpc.admin.getUsers({ page: 0, limit: 50 });
  return { users: result.users };
}
```

`context.trpc` is a typed tRPC caller created via `createCallerFactory(appRouter)` — same router, no HTTP roundtrip.

### Client-side calls

> Note: real admin pages (`/admin/users`) are loader-driven, not client-driven. The pattern below is the **generic React-Query shape** for any future client-side procedure.

```typescript
import { api } from "@/trpc/client";

// query example (generic shape — no real call site uses this for admin today)
const { data, isLoading } = api.user.getUsers.useQuery();

// mutation + cache invalidation
const utils = api.useUtils();
const mutation = api.admin.updateUser.useMutation({
  onSuccess: () => { toast.success("Saved"); utils.admin.getUsers.invalidate(); },
  onError: (e) => toast.error(e.message),
});
```

---

## Procedure types

Defined in `app/trpc/index.ts`. All three include the `timingMiddleware` that logs procedure duration via `loggers.trpc`.

| Procedure | Requirement | Context guarantees |
|-----------|-------------|--------------------|
| `publicProcedure` | None | `ctx.auth` may be `null` |
| `protectedProcedure` | Logged in | `ctx.auth.user` and `ctx.auth.session` non-null |
| `adminProcedure` | Admin role | `ctx.auth.user.role === "admin"` non-null |

`protectedProcedure` and `adminProcedure` middleware throws `TRPCError` directly for auth failures — that is intentional **control flow** for the unauthenticated/forbidden case, not a domain error. Tagged errors are reserved for repository / domain failures.

---

## Page route table

From [`app/routes.ts`](../../app/routes.ts):

| Path | File | Notes |
|------|------|-------|
| `/api/trpc/*` | `routes/api/trpc.$.ts` | tRPC HTTP handler |
| `/api/auth/*` | `routes/api/auth.$.ts` | Better Auth handler |
| `/api/upload-file` | `routes/api/upload-file.ts` | R2 upload — auth + size/type validated |
| `/` | `routes/home.tsx` | Public marketing page |
| `/:lng` | same | Locale-prefixed variant |
| `/login`, `/sign-up` | `routes/authentication/{login,sign-up}.tsx` | Redirect to `/dashboard` if session present. `:lng` variants exist. |
| `/dashboard`, `/dashboard/_index` | `routes/dashboard/{_layout,_index}.tsx` | Layout loader gates: redirects to `/login` if no session |
| `/admin` | `routes/admin/_layout.tsx` + `_index.tsx` | ⚠ **Layout has no auth gate today.** Index is the analytics dashboard |
| `/admin/users` | `routes/admin/users.tsx` | User management |
| `/admin/kitchen-sink` | `routes/admin/kitchen-sink.tsx` | Component showcase |

Locale prefixes: only `/`, `/login`, `/sign-up` accept the `/:lng/` variant. `/dashboard` and `/admin` are not locale-prefixed.

## Auth endpoints (Better Auth)

Mounted at `/api/auth/*` via the catch-all route `app/routes/api/auth.$.ts`. Both `loader` and `action` delegate to `auth.handler(request)`.

```
POST /api/auth/sign-up/email     { email, password, name }
POST /api/auth/sign-in/email     { email, password }
POST /api/auth/sign-out
GET  /api/auth/get-session       (cookie)
```

Client SDK:

```typescript
import { authClient } from "@/auth/client";

await authClient.signUp.email({ email, password, name });
await authClient.signIn.email({ email, password });
await authClient.signOut();
const { data: session } = authClient.useSession();
```

---

## File upload

```
POST /api/upload-file
Content-Type: multipart/form-data
Body: FormData with 'file' field

Requires an authenticated session (cookie) — no session → 401 before the body is even read.

Success → 200 { success: true, key: string }    // key = "uploads/<timestamp>-<uuid>"
Failure → 401 { success: false, error: "Unauthorized" }                      // no session
        | 400 { success: false, error: "No file provided" }                 // missing file field
        | 400 { success: false, error: "File must be one of [...] and at most 10MB" } // size/type
        | 500 { success: false, error: "Internal Server Error" }            // unrecoverable
```

Implemented at [`app/routes/api/upload-file.ts`](../../app/routes/api/upload-file.ts). Backed by `BucketRepository.upload` over the `BUCKET` (R2) binding. The response returns the **R2 object key** — there is no signed-URL or public-URL construction today.

Every branch — success and failure alike — now returns a consistent JSON envelope `{ success: boolean, key?: string, error?: string }`, so client code (`app/components/file-upload.tsx`) narrows on `"success" in data` rather than juggling different shapes per status code. The action:
1. Resolves the session via `context.auth.api.getSession(...)` first — `401` if absent, before `request.formData()` is even read.
2. Validates `{ size, type }` against `MAX_UPLOAD_SIZE_BYTES` (10MB) + `ALLOWED_UPLOAD_CONTENT_TYPES` from [`app/lib/constants/upload.ts`](../../app/lib/constants/upload.ts) via an Effect Schema struct — `400` with a descriptive message on failure.
3. Uploads via `BucketRepository.upload` — unrecoverable failures degrade to a generic `500` (never leak `Cause.pretty(...)` to the client; see [`rules/routes.md`](../rules/routes.md) HTTP boundary pattern).

```typescript
const formData = new FormData();
formData.append("file", file);
const res = await fetch("/api/upload-file", { method: "POST", body: formData });
const { success, key, error } = await res.json();
```

---

## Error responses

### tRPC error envelope

```typescript
{
  error: {
    message: string;
    code: "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "BAD_REQUEST" | "INTERNAL_SERVER_ERROR" | "BAD_GATEWAY";
    data?: {
      schemaError?: Array<{ path: ReadonlyArray<unknown>; message: string }>;
    };
  };
}
```

### Tagged error → TRPC code mapping

Single mapping point: `tagToTRPC` in `app/lib/effect-trpc.ts`.

| Tagged error | TRPC code |
|--------------|-----------|
| `NotFoundError`, `BucketNotFoundError` | `NOT_FOUND` |
| `ValidationError`, `BucketValidationError` | `BAD_REQUEST` |
| `CreationError`, `UpdateError`, `DeletionError`, `QueryError`, `ConfigurationError`, `Bucket{Binding,Upload,Get,Delete,List}Error`, `WorkflowTriggerError` | `INTERNAL_SERVER_ERROR` |
| `ExternalServiceError` | `BAD_GATEWAY` |

To add a new tagged error: define in `app/models/errors/`, add a `case` to `toTRPC` in `app/lib/effect-trpc.ts`, add a unit test in `app/lib/__tests__/effect-trpc.test.ts`. See [`../rules/errors.md`](../rules/errors.md).

---

## Context object

Created in `app/trpc/index.ts` as `createTRPCContext({ headers, runtime })`:

```typescript
type Context = {
  headers: Headers;
  runtime: AppRuntime;          // ManagedRuntime composing all Layers
  auth: { session, user } | null;
};
```

After `protectedProcedure`, `ctx.auth` is non-null. After `adminProcedure`, `ctx.auth.user.role === "admin"`.

The React Router `AppLoadContext` (declared in `workers/app.ts`) is separate:

```typescript
interface AppLoadContext {
  cloudflare: { env: Env; ctx: ExecutionContext };
  trpc: ReturnType<typeof createCaller>;
  auth: Auth;                   // Better Auth instance (raw)
  runtime: AppRuntime;
}
```

There is **no** `context.db`, `context.posthog`, or `context.stripe`. Bindings come from `context.cloudflare.env`. Database goes through repositories via `context.trpc.*` or `context.runtime.runPromise(Effect.gen(...))`.
