import { Effect, Exit, Layer } from "effect";

import { BoardRepository } from "@/repositories/board";
import {
  ConfigurationError,
  ExternalServiceError,
  type NotFoundError,
  type QueryError,
} from "@/models/errors/repository";
import { readGrantCookies, verifyControllerGrants } from "@/lib/board/pairing";
import {
  MAX_AUDIO_BYTES,
  isAllowedAudioContentType,
  declaredLengthOver,
  readBoundedBody,
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
 * Non-enumeration is preserved with the same split, and which refusal you get
 * depends only on what the caller *sent* — never on whether the board exists:
 *
 * - No grant cookie for this id and no owning session → **404**, byte-identical
 *   to what an invented board id returns. A signed-in non-owner gets it too.
 * - A grant cookie for this id that does not verify → **401**, so the phone
 *   knows to rescan. A board that does not exist gets the same 401 once a cookie
 *   has been presented. Anyone can fabricate that cookie for any id, so neither
 *   branch reveals whether the id is real.
 *
 * This route spends money on every call that reaches the binding, which is why
 * authorisation runs **before** the body is read: an unauthorised caller never
 * gets a megabyte buffered on its behalf, let alone an inference call. And an
 * *authorised* caller is bounded while it is read, not after — see
 * `readBoundedBody`.
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

    // Two layers, and the second is the one that actually enforces.
    //
    // `Content-Length` is the free rejection: when the client declares an
    // oversized body we refuse before reading a byte. But it is client-supplied
    // and *absent on a chunked upload*, which is how this used to be defeated —
    // `Number(null)` is `0`, finite and under the limit, so a missing header
    // sailed past, and the real check ran only after `request.arrayBuffer()` had
    // already materialised the whole body. A 100MB chunked POST was fully
    // buffered in a 128MB isolate before it earned its 413.
    //
    // So: a missing or unparseable header is treated as **unknown**, not zero,
    // and the body is read through a counting `TransformStream` that errors the
    // stream — cancelling the source — the moment the cap is passed. Peak memory
    // is bounded by `MAX_AUDIO_BYTES` plus one chunk, whatever the sender claims.
    if (declaredLengthOver(request.headers.get("content-length"), MAX_AUDIO_BYTES)) {
      return refuse(TOO_LARGE_REASON, 413);
    }

    const read = yield* readBoundedBody(request.body, MAX_AUDIO_BYTES);
    if (!read.ok) return refuse(TOO_LARGE_REASON, 413);
    const body = read.bytes;

    /* ---------------------------------------------------------------------- */
    /* 3. Transcribe                                                         */
    /* ---------------------------------------------------------------------- */

    const transcription = yield* Transcription;
    const result = yield* transcription.transcribe({
      audio: body,
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

    /** Refused for presenting an unusable grant. Never says whether the id is real. */
    const unauthorized = (reason: string) =>
      Effect.logWarning("Transcribe grant refused").pipe(
        // Precise server-side, generic client-side — the same split as the tRPC
        // routes and the socket.
        Effect.annotateLogs({ boardId, reason }),
        Effect.as(new Response("Unauthorized", { status: 401 }))
      );

    // Read off the request before any I/O, so which refusal this caller can get is
    // fixed by what they sent rather than by what the board read finds.
    const cookies = readGrantCookies(request.headers.get("cookie"), boardId);

    // The grant's MAC covers the board's `grantEpoch`, so the row must be read
    // before a grant can be verified. `NotFoundError` folds into `null`; a
    // `QueryError` still propagates to the 503.
    const repo = yield* BoardRepository;
    const board = yield* repo
      .getBoard({ boardId })
      .pipe(Effect.catchTag("NotFoundError", () => Effect.succeed(null)));

    if (board !== null && session && board.ownerId === session.user.id) {
      return "ok";
    }
    // An authenticated non-owner is not disqualified — they may still hold a
    // grant for this board (a signed-in phone that scanned someone's QR).

    if (cookies.length === 0) return notFound();

    // A cookie was presented, so every remaining outcome is 401 — "no such board"
    // included. A 404 here would let any signed-in caller sort real board ids from
    // invented ones with one junk cookie.
    if (board === null) return yield* unauthorized("missing");

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

    return "ok";
  });
