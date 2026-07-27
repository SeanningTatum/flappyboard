import { Effect, Exit } from "effect";
import { BoardRepository } from "@/repositories/board";
import {
  ConfigurationError,
  ExternalServiceError,
} from "@/models/errors/repository";
import { readGrantCookie, verifyControllerGrant } from "@/lib/board/pairing";
import type { Route } from "./+types/board-ws";

/**
 * The browser's door into a board's Durable Object. tRPC can't carry a protocol
 * upgrade, so the live socket needs its own resource route: authorise the caller
 * for this exact board, then hand the upgrade straight to the room.
 *
 * The DO stub's 101 Response (with its `webSocket`) is returned untouched —
 * wrapping or copying it would drop the socket.
 *
 * **Authorisation mirrors `requireBoardAccess` in `app/trpc/routes/board.ts`**:
 * owner session **or** a controller grant for this exact board. A paired phone has
 * no account, so requiring a session here would leave the one device that drives
 * the board unable to see it — which is what the `boardId: ""` workaround in
 * `routes/board/control.tsx` was papering over.
 *
 * Non-enumeration is preserved, and which refusal you get depends only on what the
 * caller *sent*:
 *
 * - No grant cookie for this id and no owning session → **404**, exactly what an
 *   invented board id returns. A signed-in non-owner gets the same 404, so the
 *   response never confirms that an id is real.
 * - A grant cookie for this id that does not verify → **401**, so the phone knows
 *   to rescan. Anyone can fabricate that cookie for any id, so the branch reveals
 *   nothing about the id itself.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a websocket upgrade", { status: 426 });
  }

  const boardId = new URL(request.url).searchParams.get("boardId");
  if (boardId === null || boardId === "") {
    return new Response("Missing boardId", { status: 400 });
  }

  const namespace = (context.cloudflare.env as Env & {
    BOARD?: DurableObjectNamespace;
  }).BOARD;
  if (!namespace) {
    return new Response("Board rooms are not configured", { status: 503 });
  }

  /** A fresh Response each time — a Response body is single-use. */
  const notFound = () => new Response("Not found", { status: 404 });

  const program = Effect.gen(function* () {
    const upgrade = Effect.tryPromise({
      try: () => {
        const stub = namespace.get(namespace.idFromName(boardId));
        return stub.fetch(
          `https://board-room.internal/ws?boardId=${encodeURIComponent(boardId)}`,
          { headers: { Upgrade: "websocket" } }
        );
      },
      catch: (cause) => new ExternalServiceError({ service: "BoardRoom", cause }),
    });

    const session = yield* Effect.tryPromise({
      try: () => context.auth.api.getSession({ headers: request.headers }),
      catch: (cause) => new ExternalServiceError({ service: "BetterAuth", cause }),
    });

    if (session) {
      const repo = yield* BoardRepository;
      const board = yield* repo.getBoard({ boardId });
      if (board.ownerId === session.user.id) return yield* upgrade;
      // An authenticated non-owner is not disqualified — they may still hold a
      // grant for this board (a signed-in phone that scanned someone's QR).
    }

    const cookie = readGrantCookie(request.headers.get("cookie"), boardId);
    if (cookie === null) return notFound();

    // Same secret, same read path as `app/trpc/routes/board.ts`: the
    // `BETTER_AUTH_SECRET` off the already-constructed Better Auth instance.
    // `context.auth` in a loader *is* the instance `AuthApi` yields (see
    // `workers/app.ts`), so this is one secret with one read path — not a second
    // way of getting at it.
    const secret = context.auth.options.secret;
    if (typeof secret !== "string" || secret.length === 0) {
      return yield* Effect.fail(
        new ConfigurationError({ service: "Pairing", field: "BETTER_AUTH_SECRET" })
      );
    }

    const verdict = yield* verifyControllerGrant({
      token: cookie,
      boardId,
      secret,
      now: Date.now(),
    });
    if (!verdict.ok) {
      // Precise server-side, generic client-side — same split as the tRPC routes.
      yield* Effect.logWarning("Board socket grant refused").pipe(
        Effect.annotateLogs({ boardId, reason: verdict.reason })
      );
      return new Response("Unauthorized", { status: 401 });
    }

    // The grant verified, so the id is real *and* signed by us — but the board row
    // may have been deleted since. `getBoard` failing lands on the same 404.
    const repo = yield* BoardRepository;
    yield* repo.getBoard({ boardId });

    return yield* upgrade;
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("Board socket upgrade failed", cause)
    ),
    Effect.catchTags({
      NotFoundError: () => Effect.succeed(notFound()),
      QueryError: () =>
        Effect.succeed(new Response("Service unavailable", { status: 503 })),
      ConfigurationError: () =>
        Effect.succeed(new Response("Service unavailable", { status: 503 })),
      ExternalServiceError: () =>
        Effect.succeed(new Response("Service unavailable", { status: 503 })),
    })
  );

  const exit = await context.runtime.runPromiseExit(program);
  return Exit.match(exit, {
    onSuccess: (response) => response,
    onFailure: () => new Response("Internal Server Error", { status: 500 }),
  });
}
