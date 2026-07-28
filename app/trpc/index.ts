import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { Cause, Effect, Exit, ParseResult, Schema } from "effect";
import { Session, SessionLive } from "@/services/session";
import type { AppRuntime } from "@/runtime";
import { loggers } from "@/lib/logger";

// Decision (fix 5): wire the already-tested `Session`/`SessionLive` service
// in as the single source of truth for session resolution, rather than
// deleting it. `SessionLive(headers)` is per-request (needs the request's
// Headers) so it's provided locally here — exactly the pattern documented
// in `.brain/rules/services.md` "Session" section — instead of being added
// to the global `AppServices` union in runtime.ts, which is built once per
// request before headers are threaded through and has no per-request
// parameter today. This also replaces the previous `Effect.promise(() =>
// api.getSession(...))`, which turned a throwing Better Auth call into an
// unrecoverable defect; `SessionLive` already wraps it in `Effect.tryPromise`
// mapped to `ExternalServiceError`.
export const createTRPCContext = async (opts: {
  headers: Headers;
  runtime: AppRuntime;
}) => {
  const exit = await opts.runtime.runPromiseExit(
    Session.pipe(Effect.provide(SessionLive(opts.headers)))
  );

  if (Exit.isFailure(exit)) {
    loggers.trpc.error(
      { cause: Cause.pretty(exit.cause) },
      "Failed to resolve session for tRPC context"
    );
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal Server Error",
    });
  }

  const { session, user } = exit.value;

  return {
    headers: opts.headers,
    runtime: opts.runtime,
    auth: session && user ? { session, user } : null,
  };
};

const formatSchemaError = (cause: unknown) => {
  if (ParseResult.isParseError(cause)) {
    return ParseResult.ArrayFormatter.formatErrorSync(cause).map((issue) => ({
      path: issue.path,
      message: issue.message,
    }));
  }
  return null;
};

/**
 * `isDev` is passed **explicitly**, and that matters more than it looks.
 *
 * Left unset, tRPC resolves it at runtime from
 * `globalThis.process?.env["NODE_ENV"] !== "production"`. The Workers runtime does
 * not guarantee that variable and `wrangler.jsonc` declares no `vars`, so in
 * production it was `undefined !== "production"` → **true**: every tRPC error
 * response carried `data.stack`, handing server stack traces to any unauthenticated
 * caller of `pair` or `claim`. `import.meta.env.DEV` is a build-time constant Vite
 * substitutes literally, so the value is baked into the bundle instead of depending
 * on an environment variable that may not exist.
 */
const isDev = import.meta.env.DEV;

const t = initTRPC.context<typeof createTRPCContext>().create({
  transformer: superjson,
  isDev,
  errorFormatter: ({ shape, error }) => ({
    ...shape,
    data: {
      // Spread first, then overwrite: `stack` is destructured out below rather
      // than trusted to be absent. `isDev: false` already stops tRPC adding it,
      // but a stack trace reaching a client must not depend on one flag being
      // right — this makes it structurally impossible in either mode, at the one
      // place every error response is shaped.
      ...omitStack(shape.data),
      schemaError: formatSchemaError(error.cause),
      retryAfter: rateLimitRetryAfter(error.cause),
    },
  }),
});

/**
 * Seconds to wait, when the failure was a spend-cap refusal; `null` otherwise.
 *
 * Deliberately narrow: it reads `retryAfter` only off a `RateLimitError` cause,
 * so no other error can put a number here. That keeps this an explicit
 * allowlist rather than a hole that leaks whatever a future `cause` happens to
 * carry — the same discipline `omitStack` above exists for.
 */
function rateLimitRetryAfter(cause: unknown): number | null {
  if (typeof cause !== "object" || cause === null) return null;
  const tagged = cause as { _tag?: unknown; retryAfter?: unknown };
  if (tagged._tag !== "RateLimitError") return null;
  return typeof tagged.retryAfter === "number" &&
    Number.isFinite(tagged.retryAfter)
    ? tagged.retryAfter
    : null;
}

/** Drop `stack` from an error shape's `data`, whatever put it there. */
function omitStack<T extends object>(data: T): Omit<T, "stack"> {
  const { stack: _stack, ...rest } = data as T & { stack?: unknown };
  return rest as Omit<T, "stack">;
}

export const createTRPCRouter = t.router;

const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();
  const log = loggers.trpc.child({ path });

  log.debug("Procedure starting");

  // `import.meta.env.DEV`, not `t._config.isDev`: the config value is a runtime
  // property read, so the bundler has to keep this block *and* the artificial
  // 100-500ms delay in the production bundle. Branching on the build-time constant
  // makes it `if (false) { … }`, which is dead code the bundler removes outright —
  // the delay cannot ship at all, rather than merely not firing.
  if (import.meta.env.DEV) {
    const waitMs = Math.floor(Math.random() * 400) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const durationMs = Date.now() - start;
  log.info({ durationMs }, "Procedure complete");

  return result;
});

export const publicProcedure = t.procedure.use(timingMiddleware);

export const protectedProcedure = t.procedure
  .use(timingMiddleware)
  .use(({ ctx, next }) => {
    if (!ctx.auth) {
      throw new TRPCError({ code: "UNAUTHORIZED" });
    }
    return next({
      ctx: {
        ...ctx,
        auth: {
          session: ctx.auth.session,
          user: ctx.auth.user,
        },
      },
    });
  });

export const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.auth.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Admin access required",
    });
  }
  return next();
});

export const createCallerFactory = t.createCallerFactory;

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

export { Schema };
