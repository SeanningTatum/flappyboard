import { Effect, Exit, Layer } from "effect";

import { BoardRepository } from "@/repositories/board";
import {
  ConfigurationError,
  ExternalServiceError,
  type NotFoundError,
  type QueryError,
} from "@/models/errors/repository";
import { readGrantCookie, verifyControllerGrant } from "@/lib/board/pairing";
import {
  MAX_AUDIO_BYTES,
  isAllowedAudioContentType,
} from "@/lib/board/voice";
import { Transcription, TranscriptionLive } from "@/services/transcription";
import { CloudflareEnvLive } from "@/services/cloudflare";
import { supportedLngs } from "@/i18n/i18n";
import type { Route } from "./+types/transcribe";

/**
 * `POST /api/transcribe?boardId=<id>` — the audio → text hop behind the
 * walkie-talkie button. Body is the raw recording, response is
 * `{ transcript }`.
 *
 * **Why a resource route and not a tRPC procedure:** the payload is a binary
 * blob. tRPC's transport is JSON, so going through it would mean base64ing the
 * clip on the phone (+33% over a mobile uplink) and again on the way to the
 * binding. The same reason `/api/upload-file` exists.
 *
 * **Nothing is stored.** The clip is read into memory, encoded, sent to the AI
 * binding and dropped when the request ends. There is no R2 binding on this path
 * and none is wanted: a voice recording made in someone's living room is the
 * last thing that should acquire a durable key.
 *
 * ## Authorisation
 *
 * Identical to `board-ws.ts`, deliberately and by reuse: owner **session** or a
 * verified **controller grant** for this exact board. A paired phone has no
 * account, and it is the device that holds the button — requiring a session
 * would authorise everyone except the intended user. The grant secret is read
 * the same single way, `context.auth.options.secret`, so there is one secret
 * with one read path across the whole board surface.
 *
 * Non-enumeration is preserved with the same split:
 *
 * - No grant cookie for this id and no owning session → **404**, byte-identical
 *   to what an invented board id returns. A signed-in non-owner gets it too.
 * - A grant cookie for this id that does not verify → **401**, so the phone
 *   knows to rescan. Anyone can fabricate that cookie for any id, so the branch
 *   reveals nothing about whether the id is real.
 *
 * This route spends money on every call that reaches the binding, which is why
 * authorisation runs **before** the body is read: an unauthorised caller never
 * gets a megabyte buffered on its behalf, let alone an inference call.
 */

/** A fresh Response each time — a Response body is single-use. */
const refuse = (error: string, status: number) =>
  Response.json({ error }, { status });

const notFound = () => new Response("Not found", { status: 404 });

const TOO_LARGE_REASON = `That recording is too long. Keep it under ${
  MAX_AUDIO_BYTES / 1024
}KB.`;
const WRONG_TYPE_REASON = "That upload was not audio.";
const UNAVAILABLE = "Voice input is unavailable right now. Try again.";

/** `?lang=` is honoured only when it is one of the app's own locales. */
const languageHint = (value: string | null): string | undefined =>
  value !== null && (supportedLngs as readonly string[]).includes(value)
    ? value
    : undefined;

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const url = new URL(request.url);
  const boardId = url.searchParams.get("boardId");
  if (boardId === null || boardId === "") {
    return refuse("Missing boardId", 400);
  }

  const program = Effect.gen(function* () {
    /* ---------------------------------------------------------------------- */
    /* 1. Authorise                                                          */
    /* ---------------------------------------------------------------------- */

    const authorised = yield* authorise({ request, context, boardId });
    if (authorised !== "ok") return authorised;

    /* ---------------------------------------------------------------------- */
    /* 2. Bound the input, before the binding is touched                     */
    /* ---------------------------------------------------------------------- */

    const declaredType = request.headers.get("content-type");
    if (!isAllowedAudioContentType(declaredType)) {
      return refuse(WRONG_TYPE_REASON, 415);
    }

    // Checked twice on purpose. `Content-Length` is the cheap rejection — it
    // costs nothing and refuses an oversized body before a byte is buffered —
    // but it is client-supplied and absent on a chunked upload, so the real
    // enforcement is the actual byte count below.
    const declaredLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
      return refuse(TOO_LARGE_REASON, 413);
    }

    const body = yield* Effect.tryPromise({
      try: () => request.arrayBuffer(),
      catch: (cause) => new ExternalServiceError({ service: "AudioRead", cause }),
    });
    if (body.byteLength > MAX_AUDIO_BYTES) {
      return refuse(TOO_LARGE_REASON, 413);
    }

    /* ---------------------------------------------------------------------- */
    /* 3. Transcribe                                                         */
    /* ---------------------------------------------------------------------- */

    const transcription = yield* Transcription;
    const result = yield* transcription.transcribe({
      audio: new Uint8Array(body),
      language: languageHint(url.searchParams.get("lang")),
    });

    // Never the transcript itself: what someone said into their phone is not
    // log material. Length and the model's own metadata are enough to tell a
    // silent room from a broken binding.
    yield* Effect.logInfo("Transcribed board audio").pipe(
      Effect.annotateLogs({
        boardId,
        bytes: body.byteLength,
        chars: result.transcript.length,
        language: result.language,
        durationSeconds: result.durationSeconds,
      })
    );

    return Response.json({ transcript: result.transcript });
  }).pipe(
    Effect.tapErrorCause((cause) =>
      Effect.logError("Transcribe request failed", cause)
    ),
    Effect.catchTags({
      // The one error whose `reason` is written for the person holding the
      // button — echoed verbatim, and it is the only thing that is.
      TranscriptionFailedError: (e) => Effect.succeed(refuse(e.reason, 400)),
      NotFoundError: () => Effect.succeed(notFound()),
      QueryError: () => Effect.succeed(refuse(UNAVAILABLE, 503)),
      // A missing `AI` binding lands here (the Layer fails to construct), as
      // does a missing `BETTER_AUTH_SECRET`. Both are deployment faults: 503,
      // never a stack.
      ConfigurationError: () => Effect.succeed(refuse(UNAVAILABLE, 503)),
      ExternalServiceError: () => Effect.succeed(refuse(UNAVAILABLE, 503)),
    })
  );

  /**
   * `AI` is deliberately absent from the global runtime — every member of a
   * merged layer is constructed when the runtime is built, so a Layer that can
   * fail on a missing binding would 500 every request in the app. Provided here,
   * per-request, exactly as `upload-file.ts` provides `BucketLive`: an AI-less
   * deployment breaks this one button and nothing else.
   */
  const transcriptionLayer = TranscriptionLive.pipe(
    Layer.provide(CloudflareEnvLive(context.cloudflare.env))
  );

  const exit = await context.runtime.runPromiseExit(
    program.pipe(Effect.provide(transcriptionLayer))
  );
  return Exit.match(exit, {
    onSuccess: (response) => response,
    onFailure: () => refuse("Internal Server Error", 500),
  });
}

interface AuthoriseArgs {
  readonly request: Request;
  readonly context: Route.ActionArgs["context"];
  readonly boardId: string;
}

/**
 * `"ok"` when the caller may transcribe for this board, otherwise the Response
 * to return. Lifted out of the main program only so the money-spending path
 * below it reads as a straight line — the logic is `board-ws.ts`'s, unchanged.
 */
const authorise = ({
  request,
  context,
  boardId,
}: AuthoriseArgs): Effect.Effect<
  "ok" | Response,
  ConfigurationError | ExternalServiceError | NotFoundError | QueryError,
  BoardRepository
> =>
  Effect.gen(function* () {
    const session = yield* Effect.tryPromise({
      try: () => context.auth.api.getSession({ headers: request.headers }),
      catch: (cause) => new ExternalServiceError({ service: "BetterAuth", cause }),
    });

    if (session) {
      const repo = yield* BoardRepository;
      const board = yield* repo.getBoard({ boardId });
      if (board.ownerId === session.user.id) return "ok";
      // An authenticated non-owner is not disqualified — they may still hold a
      // grant for this board (a signed-in phone that scanned someone's QR).
    }

    const cookie = readGrantCookie(request.headers.get("cookie"), boardId);
    if (cookie === null) return notFound();

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
      // Precise server-side, generic client-side — the same split as the tRPC
      // routes and the socket.
      yield* Effect.logWarning("Transcribe grant refused").pipe(
        Effect.annotateLogs({ boardId, reason: verdict.reason })
      );
      return new Response("Unauthorized", { status: 401 });
    }

    // The grant verified, so the id is real *and* signed by us — but the board
    // row may have been deleted since. `getBoard` failing lands on the same 404.
    const repo = yield* BoardRepository;
    yield* repo.getBoard({ boardId });
    return "ok";
  });
