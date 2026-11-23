import {
  AudioValidationError,
  DICTATION_LIMITS,
  PCM_SAMPLE_BYTES,
  WAV_HEADER_BYTES,
} from "./limits";
import { pcm16Sample } from "./pcm";
const PCM_FORMAT = 1;
const MONO_CHANNELS = 1;
const PCM_BITS = 16;
const FORMAT_CHUNK_BYTES = 16;
const RIFF_LENGTH_OFFSET = 8;
function ascii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index++)
    view.setUint8(offset + index, value.charCodeAt(index));
}
function isAscii(view: DataView, offset: number, value: string): boolean {
  return Array.from(value).every(
    (letter, index) => view.getUint8(offset + index) === letter.charCodeAt(0),
  );
}
/** Encodes only canonical mono16kHz PCM16; no metadata or arbitrary RIFF chunks are written. */
export function encodeDictationWav(samples: Float32Array): Uint8Array {
  if (
    !samples.length ||
    samples.length >
      DICTATION_LIMITS.sampleRate * DICTATION_LIMITS.maximumSeconds
  )
    throw new AudioValidationError(
      "The recording is empty or longer than sixty seconds.",
    );
  const bytes = new Uint8Array(
    WAV_HEADER_BYTES + samples.length * PCM_SAMPLE_BYTES,
  );
  const view = new DataView(bytes.buffer);
  ascii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - RIFF_LENGTH_OFFSET, true);
  ascii(view, 8, "WAVE");
  ascii(view, 12, "fmt ");
  view.setUint32(16, FORMAT_CHUNK_BYTES, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, MONO_CHANNELS, true);
  view.setUint32(24, DICTATION_LIMITS.sampleRate, true);
  view.setUint32(28, DICTATION_LIMITS.sampleRate * PCM_SAMPLE_BYTES, true);
  view.setUint16(32, PCM_SAMPLE_BYTES, true);
  view.setUint16(34, PCM_BITS, true);
  ascii(view, 36, "data");
  view.setUint32(40, samples.length * PCM_SAMPLE_BYTES, true);
  for (let index = 0; index < samples.length; index++)
    view.setInt16(
      WAV_HEADER_BYTES + index * PCM_SAMPLE_BYTES,
      pcm16Sample(samples[index]!),
      true,
    );
  return bytes;
}
/** Validates actual bytes independently of browser claims before trusted native transcription. */
export function validateDictationWav(bytes: Uint8Array): {
  samples: number;
  durationSeconds: number;
} {
  if (
    bytes.length <= WAV_HEADER_BYTES ||
    bytes.length > DICTATION_LIMITS.maximumUploadBytes
  )
    throw new AudioValidationError(
      "The recording is empty or exceeds the audio limit.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataBytes = bytes.length - WAV_HEADER_BYTES;
  if (
    !isAscii(view, 0, "RIFF") ||
    !isAscii(view, 8, "WAVE") ||
    !isAscii(view, 12, "fmt ") ||
    !isAscii(view, 36, "data") ||
    view.getUint32(4, true) !== bytes.length - RIFF_LENGTH_OFFSET ||
    view.getUint32(16, true) !== FORMAT_CHUNK_BYTES ||
    view.getUint16(20, true) !== PCM_FORMAT ||
    view.getUint16(22, true) !== MONO_CHANNELS ||
    view.getUint32(24, true) !== DICTATION_LIMITS.sampleRate ||
    view.getUint32(28, true) !==
      DICTATION_LIMITS.sampleRate * PCM_SAMPLE_BYTES ||
    view.getUint16(32, true) !== PCM_SAMPLE_BYTES ||
    view.getUint16(34, true) !== PCM_BITS ||
    view.getUint32(40, true) !== dataBytes ||
    dataBytes % PCM_SAMPLE_BYTES
  )
    throw new AudioValidationError(
      "Use a mono16kHz PCM16 recording from Wrenly's microphone control.",
    );
  const samples = dataBytes / PCM_SAMPLE_BYTES;
  if (samples > DICTATION_LIMITS.sampleRate * DICTATION_LIMITS.maximumSeconds)
    throw new AudioValidationError("Recordings are limited to sixty seconds.");
  return { samples, durationSeconds: samples / DICTATION_LIMITS.sampleRate };
}

const MINIMUM_SIGNAL_SAMPLES = 160; // Reject empty taps shorter than ten milliseconds.
const MINIMUM_RMS_AMPLITUDE = 0.0005;
const PCM_FULL_SCALE = 32_768;
/** Detects effectively silent input before spending native CPU; it does not establish that a sound is speech. */
export function hasDictationSignal(bytes: Uint8Array): boolean {
  const { samples } = validateDictationWav(bytes);
  if (samples < MINIMUM_SIGNAL_SAMPLES) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let energy = 0;
  for (let index = 0; index < samples; index++) {
    const amplitude =
      view.getInt16(WAV_HEADER_BYTES + index * PCM_SAMPLE_BYTES, true) /
      PCM_FULL_SCALE;
    energy += amplitude * amplitude;
  }
  return Math.sqrt(energy / samples) >= MINIMUM_RMS_AMPLITUDE;
}
