import { describe, expect, it } from "vitest";

import {
  ALLOWED_AUDIO_CONTENT_TYPES,
  MAX_AUDIO_BYTES,
  MAX_RECORDING_MS,
  MAX_TRANSCRIPT_CHARS,
  MIN_RECORDING_MS,
  RECORDER_MIME_CANDIDATES,
  baseContentType,
  bytesToBase64,
  formatElapsed,
  isAllowedAudioContentType,
  normalizeTranscript,
  pickRecorderMimeType,
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
