import { describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";

import {
  ALLOWED_AUDIO_CONTENT_TYPES,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  MAX_TRANSCRIPT_CHARS,
  MIN_RECORDING_MS,
  RECORDER_MIME_CANDIDATES,
  baseContentType,
  bytesToBase64,
  declaredLengthOver,
  readBoundedBody,
  formatElapsed,
  formatWaitEnglish,
  isAllowedAudioContentType,
  normalizeTranscript,
  pickRecorderMimeType,
  readGenerateFailure,
  readTranscribeOutcome,
} from "../voice";

describe("limits", () => {
  it("caps a press well short of a voicemail", () => {
    expect(MAX_RECORDING_MS).toBe(10_000);
    expect(MIN_RECORDING_MS).toBeLessThan(MAX_RECORDING_MS);
  });

  it("leaves headroom over a real recording but not over a podcast", () => {
    expect(MAX_AUDIO_BYTES).toBe(1024 * 1024);
  });
});

describe("baseContentType", () => {
  it("strips codec parameters", () => {
    expect(baseContentType("audio/webm;codecs=opus")).toBe("audio/webm");
  });

  it("lowercases and trims", () => {
    expect(baseContentType("  AUDIO/MP4 ; codecs=mp4a.40.2")).toBe("audio/mp4");
  });

  it("passes a bare type through", () => {
    expect(baseContentType("audio/ogg")).toBe("audio/ogg");
  });
});

describe("isAllowedAudioContentType", () => {
  it.each(ALLOWED_AUDIO_CONTENT_TYPES)("accepts %s", (type) => {
    expect(isAllowedAudioContentType(type)).toBe(true);
  });

  it("accepts a MediaRecorder type with its codec suffix", () => {
    expect(isAllowedAudioContentType("audio/webm;codecs=opus")).toBe(true);
    expect(isAllowedAudioContentType("audio/ogg; codecs=opus")).toBe(true);
  });

  it("rejects video/webm — MediaRecorder will hand you one if asked wrong", () => {
    expect(isAllowedAudioContentType("video/webm")).toBe(false);
  });

  it("rejects anything that is not audio", () => {
    expect(isAllowedAudioContentType("application/json")).toBe(false);
    expect(isAllowedAudioContentType("text/html")).toBe(false);
    expect(isAllowedAudioContentType("")).toBe(false);
  });

  it("rejects a missing header rather than defaulting to allowed", () => {
    expect(isAllowedAudioContentType(null)).toBe(false);
  });
});

describe("pickRecorderMimeType", () => {
  it("prefers opus in webm when everything is supported", () => {
    expect(pickRecorderMimeType(() => true)).toBe("audio/webm;codecs=opus");
  });

  it("falls back to mp4 on a Safari that only records AAC", () => {
    expect(pickRecorderMimeType((type) => type === "audio/mp4")).toBe("audio/mp4");
  });

  it("returns undefined when nothing matches, so MediaRecorder picks its own", () => {
    expect(pickRecorderMimeType(() => false)).toBeUndefined();
  });

  it("only ever offers types the route accepts", () => {
    for (const candidate of RECORDER_MIME_CANDIDATES) {
      expect(isAllowedAudioContentType(candidate)).toBe(true);
    }
  });
});

describe("normalizeTranscript", () => {
  it("collapses whitespace runs and newlines", () => {
    expect(normalizeTranscript("put   dinner\non\tthe board")).toBe(
      "put dinner on the board"
    );
  });

  it("trims", () => {
    expect(normalizeTranscript("  hello  ")).toBe("hello");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(normalizeTranscript("   \n\t ")).toBe("");
    expect(normalizeTranscript("")).toBe("");
  });

  it("caps a runaway transcript", () => {
    expect(normalizeTranscript("a".repeat(1000))).toHaveLength(
      MAX_TRANSCRIPT_CHARS
    );
  });
});

describe("formatElapsed", () => {
  it("renders M:SS", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(1_500)).toBe("0:01");
    expect(formatElapsed(9_999)).toBe("0:09");
    expect(formatElapsed(65_000)).toBe("1:05");
  });

  it("clamps a clock that ran backwards", () => {
    expect(formatElapsed(-5_000)).toBe("0:00");
  });
});

describe("readTranscribeOutcome", () => {
  it("reads a 200 with a transcript", () => {
    expect(readTranscribeOutcome(200, { transcript: "hello board" })).toEqual({
      ok: true,
      transcript: "hello board",
    });
  });

  it("treats a 200 with an undecodable body as a reasonless failure", () => {
    expect(readTranscribeOutcome(200, { transcript: "" })).toEqual({
      ok: false,
      reason: null,
    });
    expect(readTranscribeOutcome(200, "<html>nope</html>")).toEqual({
      ok: false,
      reason: null,
    });
  });

  it("surfaces the server's user-facing reason from a 4xx", () => {
    expect(readTranscribeOutcome(400, { error: "The recording was empty." })).toEqual(
      { ok: false, reason: "The recording was empty." }
    );
  });

  it("reports no reason when a failure body carries none", () => {
    expect(readTranscribeOutcome(503, { nope: true })).toEqual({
      ok: false,
      reason: null,
    });
    expect(readTranscribeOutcome(500, null)).toEqual({ ok: false, reason: null });
  });
});

describe("formatWaitEnglish", () => {
  it("keeps a short wait in seconds", () => {
    expect(formatWaitEnglish(1)).toBe("1 second");
    expect(formatWaitEnglish(45)).toBe("45 seconds");
    expect(formatWaitEnglish(59)).toBe("59 seconds");
  });

  it("switches to minutes past a minute — 1065 seconds is a number, not an answer", () => {
    expect(formatWaitEnglish(60)).toBe("1 minute");
    expect(formatWaitEnglish(1065)).toBe("18 minutes");
    expect(formatWaitEnglish(1238)).toBe("21 minutes");
  });

  it("rounds up, so the advice is never early", () => {
    expect(formatWaitEnglish(61)).toBe("2 minutes");
    expect(formatWaitEnglish(30.2)).toBe("31 seconds");
  });

  it("never says zero or a negative", () => {
    expect(formatWaitEnglish(0)).toBe("1 second");
    expect(formatWaitEnglish(-10)).toBe("1 second");
  });

  it("gets the singular right", () => {
    expect(formatWaitEnglish(1)).not.toContain("seconds");
    expect(formatWaitEnglish(60)).not.toContain("minutes");
  });
});

describe("readGenerateFailure", () => {
  /** The shape tRPC's error formatter actually produces on the client. */
  const trpcError = (data: unknown) => ({ data });

  it("recognises a cap refusal and its wait", () => {
    expect(
      readGenerateFailure(
        trpcError({ code: "TOO_MANY_REQUESTS", retryAfter: 1484 })
      )
    ).toEqual({ kind: "rate-limited", retryAfter: 1484 });
  });

  it("still reports the cap when the wait did not come through", () => {
    // A proxy that rewrote the body, or an older deployment. The phone can say
    // "you have hit the limit" even without a number — that is the part that
    // stops someone hammering the button.
    for (const retryAfter of [undefined, null, "60", 0, -5, Number.NaN]) {
      expect(
        readGenerateFailure(trpcError({ code: "TOO_MANY_REQUESTS", retryAfter }))
      ).toEqual({ kind: "rate-limited", retryAfter: null });
    }
  });

  it("rounds a fractional wait up, never down", () => {
    expect(
      readGenerateFailure(
        trpcError({ code: "TOO_MANY_REQUESTS", retryAfter: 30.2 })
      )
    ).toEqual({ kind: "rate-limited", retryAfter: 31 });
  });

  it("leaves every other failure generic", () => {
    expect(
      readGenerateFailure(trpcError({ code: "INTERNAL_SERVER_ERROR" }))
    ).toEqual({ kind: "other" });
    expect(readGenerateFailure(trpcError({ code: "BAD_REQUEST" }))).toEqual({
      kind: "other",
    });
  });

  it("is total — a shape it does not know degrades to generic", () => {
    // This runs inside an error handler. Throwing here would replace a handled
    // failure with an unhandled one.
    for (const junk of [
      undefined,
      null,
      "boom",
      42,
      {},
      { data: null },
      { data: "nope" },
      { message: "TOO_MANY_REQUESTS" },
      new Error("TOO_MANY_REQUESTS"),
    ]) {
      expect(readGenerateFailure(junk)).toEqual({ kind: "other" });
    }
  });

  it("does not mistake the message for the code", () => {
    // The code is the contract; the message is copy and will be reworded.
    expect(
      readGenerateFailure({
        message: "Board generate limit reached. Try again in 60s.",
        data: { code: "INTERNAL_SERVER_ERROR" },
      })
    ).toEqual({ kind: "other" });
  });
});

describe("bytesToBase64", () => {
  it("round-trips through atob", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 65, 66]);
    const decoded = atob(bytesToBase64(bytes));
    expect(Uint8Array.from(decoded, (c) => c.charCodeAt(0))).toEqual(bytes);
  });

  it("encodes an empty array to an empty string", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
  });

  /**
   * The regression this helper exists for: the naive spread form throws
   * `RangeError: Maximum call stack size exceeded` at this size.
   */
  it("survives a full-size payload without blowing the stack", () => {
    const big = new Uint8Array(MAX_AUDIO_BYTES);
    for (let i = 0; i < big.length; i += 1) big[i] = i % 256;
    const encoded = bytesToBase64(big);
    expect(encoded.length).toBe(Math.ceil(MAX_AUDIO_BYTES / 3) * 4);
    expect(atob(encoded).length).toBe(MAX_AUDIO_BYTES);
  });
});

describe("declaredLengthOver", () => {
  it("refuses a header that declares more than the limit", () => {
    expect(declaredLengthOver("2048", 1024)).toBe(true);
    expect(declaredLengthOver("1025", 1024)).toBe(true);
  });

  it("accepts a header at or under the limit", () => {
    expect(declaredLengthOver("1024", 1024)).toBe(false);
    expect(declaredLengthOver("0", 1024)).toBe(false);
  });

  /**
   * The regression: `Number(null)` is `0`, which is finite and under any limit,
   * so the old `Number(header) > limit` form silently waved through every
   * request that sent no `Content-Length` — i.e. every chunked upload, which is
   * the only kind worth defending against. Missing means *unknown*, and unknown
   * is decided by the counting reader, not here.
   */
  it("treats a missing, blank or unparseable header as unknown, not as zero", () => {
    expect(declaredLengthOver(null, 1024)).toBe(false);
    expect(declaredLengthOver(undefined, 1024)).toBe(false);
    expect(declaredLengthOver("", 1024)).toBe(false);
    expect(declaredLengthOver("   ", 1024)).toBe(false);
    expect(declaredLengthOver("banana", 1024)).toBe(false);
    expect(declaredLengthOver("-1", 1024)).toBe(false);
  });
});

describe("readBoundedBody", () => {
  /** A body delivered in `chunkSize` slices, recording whether it was cancelled. */
  const streamOf = (
    total: number,
    chunkSize: number
  ): { stream: ReadableStream<Uint8Array>; sent: () => number; cancelled: () => boolean } => {
    let sent = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, total - sent);
        controller.enqueue(new Uint8Array(size));
        sent += size;
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, sent: () => sent, cancelled: () => cancelled };
  };

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  it("reads a body that fits", async () => {
    const { stream } = streamOf(300, 100);
    const result = await run(readBoundedBody(stream, 1024));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBe(300);
  });

  it("reads a body exactly at the limit", async () => {
    const { stream } = streamOf(1024, 256);
    const result = await run(readBoundedBody(stream, 1024));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBe(1024);
  });

  /**
   * The abort path, and the whole reason this helper exists: the old code did
   * `await request.arrayBuffer()` and *then* checked the size, so a 100MB
   * chunked POST was fully buffered in a 128MB isolate before it earned its 413.
   */
  it("aborts as soon as the limit is passed, without buffering the rest", async () => {
    const huge = 100 * 1024 * 1024;
    const chunk = 64 * 1024;
    const { stream, sent, cancelled } = streamOf(huge, chunk);

    const result = await run(readBoundedBody(stream, 1024));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("too-large");
    // Stopped within a chunk or two of the cap, not 100MB later.
    expect(sent()).toBeLessThanOrEqual(1024 + chunk * 2);
    // And the sender was cut off rather than politely drained.
    expect(cancelled()).toBe(true);
  });

  it("refuses a single chunk that is over the limit on its own", async () => {
    const { stream } = streamOf(4096, 4096);
    const result = await run(readBoundedBody(stream, 1024));
    expect(result.ok).toBe(false);
  });

  it("treats a null body as zero bytes rather than an error", async () => {
    const result = await run(readBoundedBody(null, 1024));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.byteLength).toBe(0);
  });

  it("fails with ExternalServiceError when the stream itself breaks", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket died"));
      },
    });
    const exit = await Effect.runPromiseExit(readBoundedBody(broken, 1024));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("ExternalServiceError");
    }
  });
});
