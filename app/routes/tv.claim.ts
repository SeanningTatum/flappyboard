import { Effect, Exit } from "effect";
import { redirect } from "react-router";

import type { Route } from "./+types/tv.claim";
import { serializeDeviceCookie } from "@/lib/board/pairing";

/**
 * `/tv/claim?board=…&handoff=…` — the one request that exists only because a
 * WebSocket frame cannot `Set-Cookie`.
 *
 * The approval reaches the TV over its socket, but a credential the display can
 * still present tomorrow has to live in an `HttpOnly` cookie, and only an
 * ordinary HTTP response can write one. So the TV makes exactly one navigation
 * here, the handoff is redeemed for a device grant, and the browser is
 * redirected to the board with the query string gone.
 *
 * **The redirect is not cosmetic.** A bearer token left in the address bar of a
 * screen that will sit on a wall for months ends up in history, in a photograph
 * of the TV, and in the `Referer` of every request the board page makes. It is
 * the same reason `/b/:boardId/c` strips its `?t=`.
 *
 * Every failure lands on `/tv` rather than on an error page. A display that
 * could not bank its credential has exactly one useful next step — show a fresh
 * code — and there is nobody in the room to read anything else.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Off in local http dev, or the browser silently drops the cookie.
  const secure = url.protocol === "https:";
  const boardId = url.searchParams.get("board");
  const handoff = url.searchParams.get("handoff");

  if (boardId === null || boardId === "" || handoff === null || handoff === "") {
    throw redirect("/tv");
  }

  const claimed = await Effect.runPromiseExit(
    Effect.tryPromise({
      try: () => context.trpc.board.claimHandoff({ boardId, handoff }),
      catch: (cause) => cause,
    })
  );

  // A replayed handoff lands here: the nonce was spent the first time, so the
  // second attempt is refused and the TV is sent back to draw a new code. The
  // token is gone from the URL either way.
  if (Exit.isFailure(claimed)) {
    throw redirect("/tv");
  }

  throw redirect(`/b/${encodeURIComponent(boardId)}`, {
    headers: {
      "Set-Cookie": serializeDeviceCookie({
        boardId,
        token: claimed.value.grant,
        maxAgeSeconds: claimed.value.grantMaxAgeSeconds,
        secure,
      }),
    },
  });
}
