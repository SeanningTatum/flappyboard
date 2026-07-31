import { Cause, Effect, Exit, ManagedRuntime } from "effect";
import { TRPCError } from "@trpc/server";
import type { AppServices } from "@/runtime";
import type { AppError } from "@/models/errors";
import { loggers } from "@/lib/logger";

// The literal set of tags every AppError union member can carry. Anything
// with a `_tag` outside this set is NOT a known AppError — even though it
// duck-types like one — and must fall through to the generic-500 branch
// below rather than being routed into `appErrorToTRPC`'s switch.
const APP_ERROR_TAGS = new Set<AppError["_tag"]>([
  "NotFoundError",
  "CreationError",
  "UpdateError",
  "DeletionError",
  "QueryError",
  "ValidationError",
  "ConfigurationError",
  "ExternalServiceError",
  "BucketBindingError",
  "BucketUploadError",
  "BucketGetError",
  "BucketNotFoundError",
  "BucketDeleteError",
  "BucketListError",
  "BucketValidationError",
  "WorkflowTriggerError",
  "PairingTokenInvalidError",
  "BoardGenerationError",
  "LlmRefusedError",
  "TranscriptionFailedError",
  "RateLimitError",
  "DeviceCodeInvalidError",
]);

// Compile-time exhaustiveness guard for `appErrorToTRPC`'s switch. Reachable
// only if a future AppError variant's tag is added to APP_ERROR_TAGS without
// a matching switch case — never throws; logs and degrades to a generic 500
// so a missed mapping is a defect in observability, not an unhandled crash.
const assertNever = (x: never): TRPCError => {
  const tag =
    typeof x === "object" && x !== null && "_tag" in x
      ? String((x as { _tag: unknown })._tag)
      : "unknown";
  loggers.trpc.error(
    { tag },
    "appErrorToTRPC: unhandled tagged error variant — add a case + a tagToTRPC test"
  );
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal Server Error",
  });
};

const isAppError = (e: unknown): e is AppError =>
  typeof e === "object" &&
  e !== null &&
  "_tag" in e &&
  typeof (e as { _tag: unknown })._tag === "string" &&
  APP_ERROR_TAGS.has((e as { _tag: AppError["_tag"] })._tag);

const appErrorToTRPC = (e: AppError): TRPCError => {
  switch (e._tag) {
    case "NotFoundError":
      return new TRPCError({
        code: "NOT_FOUND",
        message: `${e.entity} not found: ${e.identifier}`,
      });
    case "ValidationError":
      return new TRPCError({
        code: "BAD_REQUEST",
        message: e.message,
      });
    case "CreationError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to create ${e.entity}`,
        cause: e.cause,
      });
    case "UpdateError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to update ${e.entity}`,
        cause: e.cause,
      });
    case "DeletionError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to delete ${e.entity}`,
        cause: e.cause,
      });
    case "QueryError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to query ${e.entity}`,
        cause: e.cause,
      });
    // Which piece of deployment configuration is missing is *our* problem, not
    // the caller's, and naming it is a free reconnaissance win: `pair` and
    // `generate` take no session, so an unauthenticated caller could learn
    // "BETTER_AUTH_SECRET is unset" or "ANTHROPIC_API_KEY is unset" — i.e. which
    // half of the deployment to keep poking at. `service` and `field` stay in the
    // server log; the client gets the same generic 500 as any other internal
    // fault, so a config gap is not even distinguishable from a bug.
    case "ConfigurationError":
      loggers.trpc.error(
        { service: e.service, field: e.field ?? null },
        "Configuration error — deployment config is missing"
      );
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal Server Error",
      });
    case "ExternalServiceError":
      return new TRPCError({
        code: "BAD_GATEWAY",
        message: `External service error: ${e.service}`,
        cause: e.cause,
      });
    case "BucketBindingError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: e.message ?? "BUCKET binding not found",
      });
    case "BucketUploadError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to upload to R2",
        cause: e.cause,
      });
    case "BucketGetError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to get from R2",
        cause: e.cause,
      });
    case "BucketNotFoundError":
      return new TRPCError({
        code: "NOT_FOUND",
        message: `File not found: ${e.key}`,
      });
    case "BucketDeleteError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to delete from R2",
        cause: e.cause,
      });
    case "BucketListError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to list R2 objects",
        cause: e.cause,
      });
    case "BucketValidationError":
      return new TRPCError({
        code: "BAD_REQUEST",
        message: e.message,
      });
    case "WorkflowTriggerError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `Failed to trigger workflow: ${e.name}`,
        cause: e.cause,
      });
    // The client is told to rescan and nothing else. `e.reason`
    // (malformed / bad-signature / expired / spent / missing) is deliberately
    // NOT in the message: distinguishing those for a caller turns pairing into
    // an oracle for probing tokens. The reason is logged where it is raised.
    case "PairingTokenInvalidError":
      return new TRPCError({
        code: "UNAUTHORIZED",
        message: "Pairing is no longer valid — rescan the code on the board",
      });
    // The model call itself failed. Never raised for a badly-shaped board —
    // those are retried and then repaired — so reaching here means there was
    // no usable response at all, which is ours to fix, not the caller's.
    case "BoardGenerationError":
      return new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "The board agent could not be reached — try again",
        cause: e.cause,
      });
    // A refusal is about what was *asked*, so 400 and not 500: retrying the same
    // prompt verbatim cannot succeed. `e.category` (cyber / bio / …) stays in the
    // log — a policy label is not something the phone can act on.
    case "LlmRefusedError":
      return new TRPCError({
        code: "BAD_REQUEST",
        message: "The board agent declined that prompt — try rephrasing it",
      });
    // Also the caller's input rather than a server fault: the recording was
    // unusable, so the phone should prompt for another one. `reason` is written
    // to be client-safe, so it is included.
    case "TranscriptionFailedError":
      return new TRPCError({
        code: "BAD_REQUEST",
        message: `Could not transcribe the recording: ${e.reason}`,
      });
    // Both fields are the caller's own usage of a board they are already
    // authorised for, so unlike a pairing refusal there is nothing to withhold —
    // and `retryAfter` is what lets the phone say something useful.
    case "RateLimitError":
      return new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `Board ${e.endpoint} limit reached. Try again in ${e.retryAfter}s.`,
        // Carried so the error formatter can put `retryAfter` on `data` as a
        // number. Without it the only way for the phone to learn the wait would
        // be to scrape it back out of this message string, which is a contract
        // nobody should have to keep.
        cause: e,
      });
    // Told in full, unlike a pairing refusal. The caller is a signed-in owner
    // approving a code against their own board — the code identifies nothing of
    // anyone else's, so there is no oracle here, and "already used" is exactly
    // what stops them typing it again. Guessing is bounded by the spend cap on
    // the procedure, not by this message.
    case "DeviceCodeInvalidError":
      return new TRPCError({
        code: "NOT_FOUND",
        message:
          e.reason === "already-approved"
            ? "That code has already been used — the TV should show a new one"
            : "No TV is waiting on that code — check it, or reload the TV for a new one",
      });
    default:
      return assertNever(e);
  }
};

// Generic fallback for anything that isn't a pre-existing TRPCError or a
// known AppError (a raw thrown Error, a rejected promise's reason, etc).
// The raw message/stack is logged server-side only — never sent to the
// client, which only ever sees a generic "Internal Server Error".
const toTRPC = (err: unknown): TRPCError => {
  if (err instanceof TRPCError) return err;
  if (isAppError(err)) return appErrorToTRPC(err);
  loggers.trpc.error(
    {
      err:
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack }
          : err,
    },
    "Unhandled error in tRPC procedure"
  );
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal Server Error",
  });
};

export const tagToTRPC = <A, E, R>(
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, TRPCError, R> =>
  Effect.catchAll(effect, (err) => Effect.fail(toTRPC(err)));

// The runtime's own layer construction can fail — a missing D1/R2/Workflow
// binding or a broken Better Auth config surfaces as ConfigurationError |
// ExternalServiceError | BucketBindingError when the request-scoped
// ManagedRuntime resolves its services. That failure is NOT part of
// `effect`'s own error channel (E) — it's injected by the runtime when it
// builds AppServices — so it can only be observed via `runPromiseExit`,
// never by wrapping `effect` itself in `catchAll` beforehand. We run the
// already-mapped (tagToTRPC) effect via `runPromiseExit` and translate BOTH
// the effect's own (now-TRPCError) failures and any layer-construction
// failure through the same `toTRPC` mapping, so a missing binding produces a
// clean, logged 500 instead of a raw rejection.
export const runProcedure = <A, E, R extends AppServices = AppServices>(
  runtime: ManagedRuntime.ManagedRuntime<AppServices, AppError>,
  effect: Effect.Effect<A, E, R>,
  options?: { readonly span?: string }
): Promise<A> =>
  runtime
    .runPromiseExit(
      tagToTRPC(effect).pipe(
        Effect.annotateLogs({ layer: "trpc" }),
        // Root span per procedure — every db.* child span and every log's
        // traceId hang off this. Name convention: `trpc.<router>.<procedure>`.
        options?.span
          ? Effect.withSpan(options.span, { kind: "server" })
          : (self) => self
      )
    )
    .then((exit) =>
      Exit.match(exit, {
        onSuccess: (value) => value,
        onFailure: (cause) => {
          const failure = Cause.failureOption(cause);
          if (failure._tag === "Some") {
            throw toTRPC(failure.value);
          }
          // Unrecoverable defect (interruption, die, etc) — log full cause,
          // never leak it to the client.
          loggers.trpc.error(
            { cause: Cause.pretty(cause) },
            "Unhandled defect in tRPC procedure"
          );
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal Server Error",
          });
        },
      })
    );
