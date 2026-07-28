import { Effect, Exit } from "effect";
import { BoardRepository } from "@/repositories/board";
import {
  ConfigurationError,
  ExternalServiceError,
} from "@/models/errors/repository";
import { BoardRoom } from "@/services/board-room";
import {
  mintControllerGrant,
  mintDeviceGrant,
  readDeviceCookies,
  readGrantCookies,
  serializeDeviceCookie,
  serializeGrantCookie,
  verifyControllerGrants,
  verifyDeviceGrants,
  DEFAULT_DEVICE_TTL_SECONDS,
  DEFAULT_GRANT_TTL_SECONDS,
} from "@/lib/board/pairing";
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
 *
 * ## Three ways in, not two
 *
 * A **device grant** (`fb_device_<boardId>`, the `fbd1` family) is now accepted
 * alongside the owner session and the controller grant. That is what lets a TV
 * hold the live socket without an account. It is checked against the board's
 * `deviceEpoch`, a different counter from the controller's `grantEpoch`, so
 * revoking the family's phones does not black out the television and un-pairing
 * the television does not sign out the family.
 *
 * ## Sliding renewal
 *
 * A grant that verifies is re-minted here and written back as a `Set-Cookie` on
 * the 101. A household connects several times a day, so in practice a phone or
 * a TV in ordinary use never reaches its expiry, while one that stops connecting
 * ages out on its own — which is the whole trade a 30-day (and 180-day) TTL is
 * only safe under.
 *
 * The re-mint **keeps the original nonce**. The nonce is the identity the
 * owner's per-device revoke names, so drawing a fresh one on renewal would
 * quietly orphan the room's record and hand the device a new identity that the
 * outstanding revocation no longer covers. Renewal extends a grant; it does not
 * issue a different one.
 */
/**
 * Attach a `Set-Cookie` to the room's 101 without losing the socket.
 *
 * The `webSocket` is carried over to the new `Response` deliberately: a 101's
 * headers are immutable, so the renewal has to be re-wrapped rather than
 * appended, and re-wrapping without passing the socket through is exactly how a
 * working upgrade turns into a dead one.
 *
 * A handshake response is still an HTTP response, so a browser banks the cookie
 * from it. If some runtime one day does not, the cost is that the grant expires
 * on its original schedule instead of sliding — a re-pair, not a lockout, which
 * is why this is safe to do on the upgrade at all.
 */
const withCookie = (response: Response, cookie: string): Response => {
  if (response.status !== 101 || !response.webSocket) return response;
  const headers = new Headers(response.headers);
  headers.append("Set-Cookie", cookie);
  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
    headers,
  });
};

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
    const deviceCookies = readDeviceCookies(
      request.headers.get("cookie"),
      boardId
    );

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

    if (cookies.length === 0 && deviceCookies.length === 0) return notFound();

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

    const now = Date.now();

    /*
      The display path first, because a TV presents only a device cookie and a
      phone presents only a grant cookie — the two never overlap in practice, and
      trying the one the caller actually sent avoids logging a spurious refusal
      for the family every time a television connects.
    */
    if (deviceCookies.length > 0) {
      const deviceVerdict = yield* verifyDeviceGrants({
        tokens: deviceCookies,
        boardId,
        deviceEpoch: board.deviceEpoch,
        secret,
        now,
      });
      if (deviceVerdict.ok) {
        const renewed = yield* mintDeviceGrant({
          boardId,
          deviceEpoch: board.deviceEpoch,
          secret,
          now,
          nonce: deviceVerdict.nonce,
        });
        return yield* upgrade.pipe(
          Effect.map((response) =>
            withCookie(
              response,
              serializeDeviceCookie({
                boardId,
                token: renewed,
                maxAgeSeconds: DEFAULT_DEVICE_TTL_SECONDS,
                secure: new URL(request.url).protocol === "https:",
              })
            )
          )
        );
      }
      // A device cookie that does not hold up is only fatal when it was the
      // only thing offered; a browser can legitimately hold both (the owner
      // testing the TV view and the controller in one profile).
      if (cookies.length === 0) return yield* unauthorized(deviceVerdict.reason);
    }

    const verdict = yield* verifyControllerGrants({
      tokens: cookies,
      boardId,
      grantEpoch: board.grantEpoch,
      secret,
      now,
    });
    if (!verdict.ok) return yield* unauthorized(verdict.reason);

    /*
      Per-device revocation is the one refusal the token cannot carry: an
      un-paired phone's cookie stays cryptographically valid, because the point
      of un-pairing one device is that the board's epoch does *not* move. So the
      room is asked, and the same call slides the record's window forward.

      Fails closed — `touchGrant` raises rather than answering `live: true` when
      the room is unreachable, and that error is deliberately not caught here.
    */
    const room = yield* BoardRoom;
    const device = yield* room.touchGrant({
      boardId,
      nonce: verdict.nonce,
      ttlSeconds: DEFAULT_GRANT_TTL_SECONDS,
    });
    if (!device.live) return yield* unauthorized("revoked");

    const renewed = yield* mintControllerGrant({
      boardId,
      grantEpoch: board.grantEpoch,
      secret,
      now,
      nonce: verdict.nonce,
    });

    return yield* upgrade.pipe(
      Effect.map((response) =>
        withCookie(
          response,
          serializeGrantCookie({
            boardId,
            token: renewed,
            maxAgeSeconds: DEFAULT_GRANT_TTL_SECONDS,
            secure: new URL(request.url).protocol === "https:",
          })
        )
      )
    );
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
