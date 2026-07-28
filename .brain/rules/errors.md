# Errors Layer

Tagged-error model with single mapping point at the tRPC boundary. **Source-of-truth files**: `app/models/errors/**`, `app/lib/effect-trpc.ts`, `app/lib/effect-utils.ts`.

> Programming model basics: see [`../codebase/effect-ts.md`](../codebase/effect-ts.md).

## Model

All errors are `Data.TaggedError` ADTs. The single mapping point from tagged error → HTTP status is `tagToTRPC` in `app/lib/effect-trpc.ts`. **No class hierarchies.** **No `Object.setPrototypeOf`.**

```typescript
// app/models/errors/widget.ts
import { Data } from "effect";

export class WidgetLockedError extends Data.TaggedError("WidgetLockedError")<{
  readonly widgetId: string;
  readonly reason: string;
}> {}
```

The argument shape becomes readonly fields on the instance. Discriminate via `_tag` or `instanceof`.

## Existing errors

### Repository (`app/models/errors/repository.ts`)

| Error | Fields | TRPC code |
|-------|--------|-----------|
| `NotFoundError` | `entity`, `identifier` | `NOT_FOUND` |
| `CreationError` | `entity`, `cause?` | `INTERNAL_SERVER_ERROR` |
| `UpdateError` | `entity`, `cause?` | `INTERNAL_SERVER_ERROR` |
| `DeletionError` | `entity`, `cause?` | `INTERNAL_SERVER_ERROR` |
| `QueryError` | `entity`, `cause?` | `INTERNAL_SERVER_ERROR` |
| `ValidationError` | `entity`, `message`, `field?` | `BAD_REQUEST` |
| `ConfigurationError` | `service`, `field?` | `INTERNAL_SERVER_ERROR` |
| `ExternalServiceError` | `service`, `cause?` | `BAD_GATEWAY` |

### Board (`app/models/errors/board.ts`)

| Error | Fields | TRPC code |
|-------|--------|-----------|
| `PairingTokenInvalidError` | `boardId`, `reason` (`malformed` \| `bad-signature` \| `expired` \| `spent` \| `missing`) | `UNAUTHORIZED` |
| `BoardGenerationError` | `stage` (`request` \| `empty`), `cause?` | `INTERNAL_SERVER_ERROR` |
| `LlmRefusedError` | — | `BAD_REQUEST` |
| `TranscriptionFailedError` | `reason`, `cause?` | `BAD_REQUEST` |
| `RateLimitError` | `endpoint` (`generate` \| `transcribe`), `retryAfter` | `TOO_MANY_REQUESTS` |

`RateLimitError` echoes **both** fields to the client, which is the opposite of `PairingTokenInvalidError` and worth the contrast: a rate-limit refusal describes the caller's own usage of a board they are *already authorised for*, so there is no oracle in it — while a pairing refusal describes a credential, where "expired" vs "bad-signature" is exactly the feedback an attacker wants. `retryAfter` is what lets the phone say something better than "try again later". `/api/transcribe` is not a tRPC route, so it returns its own 429 with a `Retry-After` header rather than going through this mapping.

### Getting a *number* to the client, not just a message

`tagToTRPC` puts `retryAfter` in the message string, but a client must never have to
scrape a number back out of copy — copy gets reworded. So `RateLimitError` is the
one case that passes `cause: e` into its `TRPCError`, and `errorFormatter` in
[`app/trpc/index.ts`](../../app/trpc/index.ts) reads `retryAfter` off that cause
onto `data`. The client reads `data.code` + `data.retryAfter`
(`readGenerateFailure` in `app/lib/board/voice.ts`).

That formatter helper is a deliberate **allowlist**, not a passthrough: it checks
`_tag === "RateLimitError"` and copies exactly one numeric field. Same discipline
as `omitStack` beside it — a future `cause` carrying something sensitive must not
be able to ride out to a client just because it happens to be attached.

> Lesson worth keeping: a tagged error's fields do not reach the browser by
> themselves. If a client needs to *act* on one, it needs a `cause` and a
> formatter line, and both need a test — otherwise the field exists, the doc
> comment promises it, and the UI still renders a generic string. That is exactly
> what happened here and three browser runs caught it.

`TranscriptionFailedError.reason` **is** echoed to the client (write it user-facing, e.g. "the recording was empty"); its `cause` is not. That is the opposite of `PairingTokenInvalidError`, where the reason is an oracle and stays server-side — the difference is that a transcription failure is the user's own audio, while a pairing failure is a credential.

**The `reason` is for the server log only.** `tagToTRPC` maps every reason to one generic "rescan the code on the board" message, because telling a caller *which* way their token failed hands them an oracle. A test asserts the reason never reaches the client — keep it that way when adding a reason.

### Bucket (`app/models/errors/bucket.ts`)

| Error | Fields | TRPC code |
|-------|--------|-----------|
| `BucketBindingError` | `message?` | `INTERNAL_SERVER_ERROR` |
| `BucketUploadError` | `cause?` | `INTERNAL_SERVER_ERROR` |
| `BucketGetError` | `cause?` | `INTERNAL_SERVER_ERROR` |
| `BucketNotFoundError` | `key` | `NOT_FOUND` |
| `BucketDeleteError` | `cause?` | `INTERNAL_SERVER_ERROR` |
| `BucketListError` | `cause?` | `INTERNAL_SERVER_ERROR` |
| `BucketValidationError` | `message`, `field?` | `BAD_REQUEST` |

### Workflow (`app/models/errors/workflow.ts`)

| Error | Fields | TRPC code |
|-------|--------|-----------|
| `WorkflowTriggerError` | `name`, `cause?` | `INTERNAL_SERVER_ERROR` |

## Adding a new tagged error

1. Define the class in `app/models/errors/{domain}.ts` (or extend an existing union)
2. Re-export from `app/models/errors/index.ts`. Add to the `AppError` union if domain-broad.
3. Add a `case "MyError":` to `toTRPC` in `app/lib/effect-trpc.ts` mapping to a TRPC code
4. Add a unit test in `app/lib/__tests__/effect-trpc.test.ts` asserting the mapping

```typescript
// app/lib/__tests__/effect-trpc.test.ts
it("maps WidgetLockedError to FORBIDDEN", () => {
  expectTRPC(
    Effect.fail(new WidgetLockedError({ widgetId: "w1", reason: "billing" })),
    "FORBIDDEN"
  );
});
```

## Using errors in repositories

Wrap drizzle / R2 calls with helpers from `@/lib/effect-utils`:

```typescript
import { tryQuery, tryUpdate, tryCreate, tryDelete, requireFound } from "@/lib/effect-utils";

const rows = yield* tryQuery("widget", () => db.select().from(widget).limit(1));
const item = yield* requireFound("widget", id, rows[0]);

yield* tryUpdate("widget", () =>
  db.update(widget).set({ /* ... */ }).where(eq(widget.id, id))
);
```

Helpers:

| Helper | Wraps | Failure |
|--------|-------|---------|
| `tryQuery(entity, () => ...)` | drizzle SELECT | `QueryError` |
| `tryCreate(entity, () => ...)` | INSERT | `CreationError` |
| `tryUpdate(entity, () => ...)` | UPDATE | `UpdateError` |
| `tryDelete(entity, () => ...)` | DELETE | `DeletionError` |
| `requireFound(entity, id, row)` | `T \| undefined → Effect<T, NotFoundError>` | `NotFoundError` |

## Using errors in tRPC procedures

`tagToTRPC` handles canonical mapping automatically — for **simple CRUD procedures** (single repo call after a pre-condition check) you do nothing.

For **complex procedures** (multi-step, third-party side effects, bulk ops, transient failures, domain-specific recovery), transform errors at the procedure layer **before** `runProcedure` falls back to `tagToTRPC`. Patterns + when-to-apply table is in [`routes.md` "Procedure-level error transformation"](routes.md#procedure-level-error-transformation). Common shapes:

| Need | Operator |
|------|----------|
| Re-map one tag with richer message | `Effect.catchTag("Tag", e => Effect.fail(new BetterTag(...)))` |
| Re-map several at once | `Effect.catchTags({ A: ..., B: ... })` |
| Retry transient infra failure | `Effect.retry({ times, schedule })` |
| Structured success/audit log | `Effect.tap` |
| Log specific failure shape | `Effect.tapErrorTag` |
| Bulk fail-tolerance | `Effect.partition` |
| SLA timeout | `Effect.timeout` |

Direct `Effect.fail(new SomeTaggedError(...))` inside an `Effect.gen` is still the right tool for **procedure-specific pre-conditions** (auth-self-check, business invariants). Example:

```typescript
.mutation(({ ctx, input }) =>
  runProcedure(
    ctx.runtime,
    Effect.gen(function* () {
      if (input.id === ctx.auth.user.id) {
        return yield* Effect.fail(
          new ValidationError({
            entity: "user",
            message: "Cannot delete self",
            field: "userId",
          })
        );
      }
      const repo = yield* UserRepository;
      return yield* repo.deleteUser({
        ...input,
        currentUserId: ctx.auth.user.id,
      });
    })
  )
)
```

## Mapping table (canonical, mirrors `tagToTRPC`)

| Tagged error | TRPC code |
|--------------|-----------|
| `NotFoundError`, `BucketNotFoundError` | `NOT_FOUND` |
| `ValidationError`, `BucketValidationError` | `BAD_REQUEST` |
| `CreationError`, `UpdateError`, `DeletionError`, `QueryError`, `ConfigurationError`, `Bucket{Binding,Upload,Get,Delete,List}Error`, `WorkflowTriggerError` | `INTERNAL_SERVER_ERROR` |
| `ExternalServiceError` | `BAD_GATEWAY` |

## `tagToTRPC` hardening — `isAppError` + generic fallback

`app/lib/effect-trpc.ts`'s `isAppError` type guard no longer trusts any object with a string `_tag` — it checks the tag against a literal `APP_ERROR_TAGS` set (one entry per `AppError` union member). An error whose `_tag` duck-types like a known tag but isn't actually registered (e.g. a third-party error that happens to have a `_tag` field) now falls through to the **generic fallback** branch — logged server-side via `loggers.trpc.error(...)` and returned to the client as a plain `INTERNAL_SERVER_ERROR` — instead of being routed into `appErrorToTRPC`'s switch, where an unregistered tag would previously have hit the `default: assertNever(e)` branch. `assertNever` itself no longer throws: it logs `"appErrorToTRPC: unhandled tagged error variant — add a case + a tagToTRPC test"` with the offending tag and degrades to the same generic 500, so a missed mapping is an observability defect, not an unhandled crash.

The generic fallback (`toTRPC`'s final branch, for anything that isn't a pre-existing `TRPCError` or a known `AppError`) also no longer leaks `err.message` / `err.stack` to the client. The raw error is logged server-side only (`loggers.trpc.error({ err: ... }, "Unhandled error in tRPC procedure")`); the client always receives `{ code: "INTERNAL_SERVER_ERROR", message: "Internal Server Error" }`. Same discipline applies at `runProcedure`'s `Exit.match` `onFailure` branch for unrecoverable defects — full `Cause.pretty(cause)` is logged, never sent to the client.

## Anti-patterns

- `throw new Error(...)` in app code (test code OK)
- `try / catch` outside `Effect.tryPromise` or `Effect.try`
- Class hierarchies with `Object.setPrototypeOf` — old style, gone
- Constructing `TRPCError` directly inside a procedure for **domain** errors — emit a tagged error and let `tagToTRPC` map it. (Only acceptable for procedure-specific control flow like auth checks.)
- Adding a tagged error without (a) registering in `tagToTRPC`'s `APP_ERROR_TAGS` set + switch case, (b) writing the mapping test
- Leaking a caught error's raw `message`/`stack` to the client in a generic-fallback branch — log it server-side, return a fixed "Internal Server Error" string
- `Effect.die` for recoverable conditions — that's for unrecoverable defects only
