import { describe, expect, it } from "vitest";

import { voiceCopyKey, type VoicePhase } from "../push-to-talk-button";
import en from "@/locales/en/board.json";
import zh from "@/locales/zh/board.json";

/**
 * Every phase the button can be in, so the tests below are exhaustive by
 * construction rather than by inspection — a new `VoicePhase` member that is not
 * added here fails to typecheck.
 */
const phases: ReadonlyArray<VoicePhase> = [
  { step: "idle" },
  { step: "recording" },
  { step: "transcribing" },
  { step: "generating" },
  { step: "done", truncated: false, repaired: false },
  { step: "done", truncated: false, repaired: true },
  { step: "done", truncated: true, repaired: false },
  { step: "error", fault: { kind: "denied" } },
  { step: "error", fault: { kind: "unsupported" } },
  { step: "error", fault: { kind: "insecure" } },
  { step: "error", fault: { kind: "tooShort" } },
  { step: "error", fault: { kind: "mic" } },
  { step: "error", fault: { kind: "transcribe", reason: null } },
  { step: "error", fault: { kind: "generate" } },
];

/** `"control.voice.hint"` → the string at that path, or `undefined`. */
const lookup = (bundle: unknown, key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, segment) =>
        typeof node === "object" && node !== null
          ? (node as Record<string, unknown>)[segment]
          : undefined,
      bundle
    );

describe("voiceCopyKey", () => {
  it("gives every phase a distinct key", () => {
    const keys = phases.map(voiceCopyKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only ever reaches into control.voice.*", () => {
    for (const phase of phases) {
      expect(voiceCopyKey(phase)).toMatch(/^control\.voice\./);
    }
  });

  it("prefers the trimmed note over the repaired one — the user lost words", () => {
    expect(voiceCopyKey({ step: "done", truncated: true, repaired: true })).toBe(
      "control.voice.trimmed"
    );
  });

  /**
   * The regression this guards: a phase whose copy exists in `en` and not in
   * `zh` renders the raw key on a Chinese phone, which looks exactly like a
   * crash.
   */
  it.each([
    ["en", en],
    ["zh", zh],
  ])("resolves every phase to a real string in %s", (_locale, bundle) => {
    for (const phase of phases) {
      const key = voiceCopyKey(phase);
      const copy = lookup(bundle, key);
      expect(copy, key).toBeTypeOf("string");
      expect(copy as string, key).not.toBe("");
    }
  });

  it.each([
    ["en", en],
    ["zh", zh],
  ])("has the button's own labels in %s", (_locale, bundle) => {
    for (const key of [
      "control.voice.title",
      "control.voice.hold",
      "control.voice.release",
    ]) {
      expect(lookup(bundle, key), key).toBeTypeOf("string");
    }
  });
});
