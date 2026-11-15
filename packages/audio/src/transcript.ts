import { AudioValidationError, DICTATION_LIMITS } from "./limits";
/** Transcripts are editable text, never markup or permission to execute an instruction. */
export function validateTranscript(value: unknown): string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).byteLength >
      DICTATION_LIMITS.maximumTranscriptBytes
  )
    throw new AudioValidationError(
      "The transcription response is invalid or too long.",
    );
  const text = value.trim();
  if (!text)
    throw new AudioValidationError(
      "No speech was recognized. Try recording again.",
    );
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127 ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      throw new AudioValidationError(
        "The transcription response contains invalid text.",
      );
  }
  return text;
}
