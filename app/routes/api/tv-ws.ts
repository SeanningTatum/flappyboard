import { Effect, Exit } from "effect";
import { ExternalServiceError } from "@/models/errors/repository";
import {
  deviceCodeRoomName,
  normalizeDeviceCode,
} from "@/lib/board/device-code";
import type { Route } from "./+types/tv-ws";

/**
 * The waiting TV's socket, `/api/tv-ws?code=…&watcher=…`.
 *
 * A sibling of `board-ws.ts` with one deliberate difference: **this route
 * authorises nothing**. There is nothing here it could authorise. The caller is
 * a display that holds no session, no cookie and no board — it knows a six
 * character code and the watcher secret it was handed when that code was drawn,
 * and both of those are facts only the room can check.
 *
 * So the route is a pure conduit: normalise the code, address the room the code
 * names, and forward the upgrade. The room compares the watcher in constant time
 * and answers 404 for every refusal, so nothing observable here distinguishes
 * "that code was never issued" from "that code exists but is not yours" — which
 * is the property that makes it safe for the code to double as an address.
 *
 * Why a socket rather than polling: approval has to reach a screen nobody is
 * standing in front of, the instant the owner taps their phone. A poll would
 * either be slow or be a request every second from a device that will sit on
 * this page for months. The socket also doubles as the liveness signal that lets
 * the room expire a code whose TV walked away — see `webSocketClose`.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a websocket upgrade", { status: 426 });
  }

  const url = new URL(request.url);
  const code = normalizeDeviceCode(url.searchParams.get("code"));
  const watcher = url.searchParams.get("watcher");
  // Refused identically to an unknown code: a malformed one must not be
  // distinguishable from a well-formed one nobody is holding.
  if (code === null || watcher === null || watcher === "") {
    return new Response("Not found", { status: 404 });
  }

  const namespace = (
    context.cloudflare.env as Env & { BOARD?: DurableObjectNamespace }
  ).BOARD;
  if (!namespace) {
    return new Response("Board rooms are not configured", { status: 503 });
  }

  const program = Effect.tryPromise({
    try: () => {
      const name = deviceCodeRoomName(code);
      const stub = namespace.get(namespace.idFromName(name));
      // The 101 Response (and the `webSocket` on it) is returned untouched —
      // copying or wrapping it would drop the socket.
      return stub.fetch(
        `https://board-room.internal/device-code/watch?watcher=${encodeURIComponent(watcher)}`,
        { headers: { Upgrade: "websocket" } }
      );
    },
    catch: (cause) => new ExternalServiceError({ service: "BoardRoom", cause }),
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("Device-code socket upgrade failed", cause)
    )
  );

  const exit = await context.runtime.runPromiseExit(program);
  return Exit.match(exit, {
    onSuccess: (response) => response,
    onFailure: () => new Response("Service unavailable", { status: 503 }),
  });
}
