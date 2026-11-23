/** Limits keep a recording short enough for bounded CPU transcription on a self-hosted instance. */
export const DICTATION_LIMITS = Object.freeze({
  sampleRate: 16_000,
  maximumSeconds: 60,
  maximumUploadBytes: 2 * 1024 * 1024,
  maximumTranscriptBytes: 8 * 1024,
  minimumCaptureRate: 16_000,
  maximumCaptureRate: 96_000,
});
export const WAV_HEADER_BYTES = 44;
export const PCM_SAMPLE_BYTES = 2;
export class AudioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioValidationError";
  }
}
