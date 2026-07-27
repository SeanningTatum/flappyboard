import { Effect, Exit } from "effect";
import { BoardRepository } from "@/repositories/board";
import {
  ConfigurationError,
  ExternalServiceError,
} from "@/models/errors/repository";
import { readGrantCookies, verifyControllerGrants } from "@/lib/board/pairing";
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
 * caller *sent* — never on whether the board exists:
 *
 * - No grant cookie for this id and no owning session → **404**, exactly what an
 *   invented board id returns. A signed-in non-owner gets the same 404, so the
 *   response never confirms that an id is real.
 * - A grant cookie for this id that does not verify → **401**, so the phone knows
 *   to rescan. A board that does not exist gets the same 401 once a cookie has
 *   been presented, so presenting one buys no information either. Anyone can
 *   fabricate that cookie for any id, so the branch reveals nothing about the id.
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

    /** Refused for presenting an unusable grant. Never says whether the id is real. */
    const unauthorized = (reason: string) =>
      Effect.logWarning("Board socket grant refused").pipe(
        // Precise server-side, generic client-side — same split as the tRPC routes.
        Effect.annotateLogs({ boardId, reason }),
        Effect.as(new Response("Unauthorized", { status: 401 }))
      );

    // Read off the request before any I/O: this fixes which refusal is reachable
    // for this caller, so the board read below cannot become an oracle.
    const cookies = readGrantCookies(request.headers.get("cookie"), boardId);

    // The grant's MAC covers the board's `grantEpoch`, so the row is needed before
    // a grant can be verified at all. `NotFoundError` is folded into `null` here —
    // a `QueryError` still propagates to the 503 below.
    const repo = yield* BoardRepository;
    const board = yield* repo
      .getBoard({ boardId })
      .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));

    if (board !== null && session && board.ownerId === session.user.id) {
      return yield* upgrade;
    }
    // An authenticated non-owner is not disqualified — they may still hold a
    // grant for this board (a signed-in phone that scanned someone's QR).

    if (cookies.length === 0) return notFound();

    // A cookie was presented, so every remaining outcome is 401 — including "no
    // such board". Answering 404 here would let any signed-in caller sort real
    // board ids from invented ones with a single junk cookie.
    if (board === null) return yield* unauthorized("missing");

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

    const verdict = yield* verifyControllerGrants({
      tokens: cookies,
      boardId,
      grantEpoch: board.grantEpoch,
      secret,
      now: Date.now(),
    });
    if (!verdict.ok) return yield* unauthorized(verdict.reason);

    return yield* upgrade;
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("Board socket upgrade failed", cause)
    ),
    // No `NotFoundError` handler, and that is not an omission: "no such board" is
    // now caught at the read (`catchTag` → `null`) so that it can only ever be
    // *answered*, never *raised*. A 404 raised from deeper in the program is
    // exactly the oracle this route was leaking.
    Effect.catchTags({
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
