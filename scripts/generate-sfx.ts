#!/usr/bin/env bun
// Deterministic synthesis of the flappyboard flap sound effects.
//
// Usage:
//   bun scripts/generate-sfx.ts
//
// Not wired into package.json's "scripts" — adding an entry would mean
// touching the line above it too (to add the trailing comma), and this
// file's mandate is to leave package.json alone. If you want a shortcut, add
// this yourself:
//   "sfx:generate": "bun scripts/generate-sfx.ts"
//
// Both WAVs are generated in pure TypeScript: a seeded PRNG drives white
// noise, shaped by an attack/decay envelope (and, for "soft", a low-pass
// filter), then hand-encoded as 16-bit PCM mono WAV. No npm audio deps, no
// binary blobs of unknown provenance — and because the PRNG is seeded
// (never `Math.random()`), re-running this script reproduces byte-for-byte
// identical files.
import fs from "node:fs";
import path from "node:path";

const SAMPLE_RATE = 44100;

/**
 * mulberry32 — tiny, fast, seeded PRNG (public-domain construction). The
 * only property that matters here: same seed in, same sequence out, forever.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** White noise in [-1, 1), driven by the seeded PRNG. */
const noise = (rand: () => number, samples: number): Float64Array =>
  Float64Array.from({ length: samples }, () => rand() * 2 - 1);

/**
 * One-pole IIR low-pass. Cheap way to turn sharp, hissy noise into a duller
 * thud — run it over the signal `passes` times to sharpen the rolloff
 * without reaching for anything more elaborate than arithmetic.
 */
const lowPass = (input: Float64Array, alpha: number, passes: number): Float64Array => {
  let signal = input;
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(signal.length);
    let prev = 0;
    for (let i = 0; i < signal.length; i++) {
      prev = prev + alpha * (signal[i]! - prev);
      out[i] = prev;
    }
    signal = out;
  }
  return signal;
};

/**
 * Percussive envelope: a near-instant attack (a handful of samples, so it
 * still reads as a click rather than a pop) followed by a steep exponential
 * decay. `tau` is in samples, not seconds — smaller means a snappier tail.
 */
const decayEnvelope = (
  samples: number,
  tau: number,
  attackSamples: number
): Float64Array =>
  Float64Array.from({ length: samples }, (_, i) => {
    const attack = i < attackSamples ? i / attackSamples : 1;
    const decay = Math.exp(-i / tau);
    return attack * decay;
  });

const applyEnvelope = (samples: Float64Array, envelope: Float64Array): Float64Array =>
  samples.map((sample, i) => sample * envelope[i]!);

const toInt16 = (samples: Float64Array, gain: number): Int16Array =>
  Int16Array.from(samples, (sample) => {
    const clamped = Math.max(-1, Math.min(1, sample * gain));
    return Math.round(clamped * 32767);
  });

/** Minimal 16-bit PCM mono WAV encoder: a 44-byte header plus 2 bytes/sample. */
const encodeWav = (samples: Int16Array, sampleRate: number): Buffer => {
  const blockAlign = 2; // mono, 16-bit
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buffer.writeUInt16LE(1, 20); // audio format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i]!, 44 + i * 2);
  }

  return buffer;
};

interface FlapSpec {
  readonly name: "classic" | "soft";
  /** Fixed seed — this is what makes the output reproducible. */
  readonly seed: number;
  readonly durationSeconds: number;
  readonly tau: number;
  readonly attackSamples: number;
  readonly lowPass: { alpha: number; passes: number } | undefined;
  readonly gain: number;
}

const SPECS: ReadonlyArray<FlapSpec> = [
  {
    // Sharp mechanical clack: short, bright, steep decay, no filtering.
    name: "classic",
    seed: 0x4c4150, // "LAP" in hex-ish, arbitrary but fixed
    durationSeconds: 0.075,
    tau: 650,
    attackSamples: 3,
    lowPass: undefined,
    gain: 0.9,
  },
  {
    // Same gesture, lower and duller: quieter, longer decay, low-passed
    // noise so the high end that makes "classic" sound sharp is gone.
    name: "soft",
    seed: 0x534f4654, // "SOFT" in hex-ish, arbitrary but fixed
    durationSeconds: 0.13,
    tau: 1700,
    attackSamples: 10,
    lowPass: { alpha: 0.15, passes: 2 },
    gain: 0.45,
  },
];

const synthesize = (spec: FlapSpec): Buffer => {
  const sampleCount = Math.round(spec.durationSeconds * SAMPLE_RATE);
  const rand = mulberry32(spec.seed);
  const raw = noise(rand, sampleCount);
  const filtered =
    spec.lowPass === undefined
      ? raw
      : lowPass(raw, spec.lowPass.alpha, spec.lowPass.passes);
  const envelope = decayEnvelope(sampleCount, spec.tau, spec.attackSamples);
  const shaped = applyEnvelope(filtered, envelope);
  const pcm = toInt16(shaped, spec.gain);
  return encodeWav(pcm, SAMPLE_RATE);
};

const repoRoot = path.resolve(import.meta.dirname, "..");

const main = (): void => {
  for (const spec of SPECS) {
    const wav = synthesize(spec);
    const dir = path.join(repoRoot, "public", "sfx", spec.name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "flap.wav");
    fs.writeFileSync(file, wav);
    console.log(`${path.relative(repoRoot, file)}: ${wav.length} bytes`);
  }
};

main();
