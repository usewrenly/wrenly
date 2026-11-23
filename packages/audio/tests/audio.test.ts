import { expect, test } from "bun:test";
import {
  DICTATION_LIMITS,
  hasDictationSignal,
  encodeDictationWav,
  validateDictationWav,
  resampleDictation,
  validateTranscript,
} from "../src";
function tone(rate: number, frequency: number): Float32Array {
  return Float32Array.from(
    { length: rate },
    (_, index) => Math.sin((2 * Math.PI * frequency * index) / rate) * 0.5,
  );
}
function rms(samples: Float32Array): number {
  const inner = samples.subarray(100, samples.length - 100);
  return Math.sqrt(
    inner.reduce((sum, sample) => sum + sample * sample, 0) / inner.length,
  );
}
test("resampling preserves duration and speech frequencies at44.1kHz and48kHz", () => {
  for (const rate of [44_100, 48_000]) {
    const source = tone(rate, 1000);
    const result = resampleDictation(source, rate);
    expect(result.length).toBe(16_000);
    expect(rms(result)).toBeGreaterThan(0.34);
    expect(rms(result)).toBeLessThan(0.37);
    let crossings = 0;
    for (let index = 1; index < result.length; index++)
      if (result[index - 1]! < 0 && result[index]! >= 0) crossings++;
    expect(crossings).toBeGreaterThan(997);
    expect(crossings).toBeLessThan(1002);
    expect(source.length).toBe(rate);
  }
});
test("downsampling removes out-of-band tones instead of merely relabelling samples", () => {
  const result = resampleDictation(tone(48_000, 12_000), 48_000);
  expect(rms(result)).toBeLessThan(0.01);
  expect(
    rms(resampleDictation(new Float32Array(48_000).fill(0.25), 48_000)),
  ).toBeCloseTo(0.25, 5);
});
test("invalid capture cannot allocate an accepted recording", () => {
  for (const rate of [0, 8000, 44_100.5, 192_000, Infinity])
    expect(() => resampleDictation(new Float32Array(100), rate)).toThrow();
  expect(() => resampleDictation(new Float32Array(), 48_000)).toThrow();
  expect(() => resampleDictation(new Float32Array([NaN]), 16_000)).toThrow();
  expect(() =>
    resampleDictation(new Float32Array([Infinity]), 16_000),
  ).toThrow();
  expect(() =>
    resampleDictation(new Float32Array(16_000 * 60 + 1), 16_000),
  ).toThrow();
});
test("canonical WAV clips finite amplitudes and independently verifies exact bytes", () => {
  const bytes = encodeDictationWav(new Float32Array([-2, -1, 0, 1, 2]));
  expect(validateDictationWav(bytes)).toEqual({
    samples: 5,
    durationSeconds: 5 / 16_000,
  });
  const view = new DataView(bytes.buffer);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(48, true)).toBe(0);
  expect(view.getInt16(52, true)).toBe(32767);
  for (const offset of [0, 4, 8, 12, 16, 20, 22, 24, 28, 32, 34, 36, 40]) {
    const corrupt = bytes.slice();
    corrupt[offset] = corrupt[offset]! ^ 1;
    expect(() => validateDictationWav(corrupt)).toThrow();
  }
  expect(() => validateDictationWav(new Uint8Array([...bytes, 0]))).toThrow();
  expect(() => encodeDictationWav(new Float32Array([NaN]))).toThrow();
});
test("maximum recording fits the upload bound; oversized and optional chunks fail", () => {
  const maximum = encodeDictationWav(new Float32Array(16_000 * 60));
  expect(maximum.length).toBeLessThan(DICTATION_LIMITS.maximumUploadBytes);
  expect(validateDictationWav(maximum).durationSeconds).toBe(60);
  expect(() => encodeDictationWav(new Float32Array(16_000 * 60 + 1))).toThrow();
  expect(() =>
    validateDictationWav(
      new Uint8Array(DICTATION_LIMITS.maximumUploadBytes + 1),
    ),
  ).toThrow();
  expect(() => validateDictationWav(maximum.subarray(0, 40))).toThrow();
});
test("transcripts retain ordinary multilingual text but reject empty, binary and oversized results", () => {
  expect(validateTranscript("  Moni! Make the title larger.\nMerci.  ")).toBe(
    "Moni! Make the title larger.\nMerci.",
  );
  for (const value of [
    null,
    {},
    " ",
    "word\u0000",
    "word\u007f",
    "word\ud800",
    "é".repeat(5000),
  ])
    expect(() => validateTranscript(value)).toThrow();
});

test("signal screening rejects silence and very short taps without claiming to recognize speech", () => {
  expect(hasDictationSignal(encodeDictationWav(new Float32Array(1600)))).toBe(
    false,
  );
  expect(hasDictationSignal(encodeDictationWav(new Float32Array([1])))).toBe(
    false,
  );
  expect(hasDictationSignal(encodeDictationWav(tone(16000, 1000)))).toBe(true);
});
