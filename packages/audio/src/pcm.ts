import { AudioValidationError, DICTATION_LIMITS } from "./limits";
const FILTER_RADIUS = 24; // Windowed sinc suppresses frequencies that would alias after downsampling.
const NYQUIST_MARGIN = 0.9;
const PCM_NEGATIVE_SCALE = 32_768;
const PCM_POSITIVE_SCALE = 32_767;
/** Resamples an entire bounded mono capture; callers must independently bound live accumulation. */
export function resampleDictation(
  samples: Float32Array,
  captureRate: number,
): Float32Array {
  if (
    !Number.isInteger(captureRate) ||
    captureRate < DICTATION_LIMITS.minimumCaptureRate ||
    captureRate > DICTATION_LIMITS.maximumCaptureRate
  )
    throw new AudioValidationError(
      "This microphone sample rate is not supported.",
    );
  if (
    !samples.length ||
    samples.length > captureRate * DICTATION_LIMITS.maximumSeconds
  )
    throw new AudioValidationError(
      "Record between one sample and sixty seconds of speech.",
    );
  for (const sample of samples)
    if (!Number.isFinite(sample))
      throw new AudioValidationError(
        "The microphone returned invalid audio samples.",
      );
  if (captureRate === DICTATION_LIMITS.sampleRate) return samples.slice();
  const ratio = captureRate / DICTATION_LIMITS.sampleRate;
  const cutoff = NYQUIST_MARGIN / ratio;
  const output = new Float32Array(Math.floor(samples.length / ratio));
  if (!output.length)
    throw new AudioValidationError("The recording is too short.");
  for (let index = 0; index < output.length; index++) {
    const center = index * ratio;
    const first = Math.ceil(center - FILTER_RADIUS);
    const last = Math.floor(center + FILTER_RADIUS);
    let sum = 0,
      normalization = 0;
    for (let source = first; source <= last; source++) {
      if (source < 0 || source >= samples.length) continue;
      const distance = source - center;
      const angle = Math.PI * distance * cutoff;
      const sinc = angle === 0 ? 1 : Math.sin(angle) / angle;
      const window = 0.5 + 0.5 * Math.cos((Math.PI * distance) / FILTER_RADIUS);
      const weight = cutoff * sinc * window;
      sum += samples[source]! * weight;
      normalization += weight;
    }
    output[index] = normalization ? sum / normalization : 0;
  }
  return output;
}
/** Clips finite microphone samples only when converting to the signed16-bit wire representation. */
export function pcm16Sample(sample: number): number {
  if (!Number.isFinite(sample))
    throw new AudioValidationError("The recording contains invalid audio.");
  const bounded = Math.max(-1, Math.min(1, sample));
  return Math.round(
    bounded * (bounded < 0 ? PCM_NEGATIVE_SCALE : PCM_POSITIVE_SCALE),
  );
}
