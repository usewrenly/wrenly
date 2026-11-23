# Audio for editable prompts

Dictation turns a short recording into words a person can review before sending.
For example: speak “Make the heading larger”, inspect the transcript, then insert it
into the existing draft. Recording itself never asks a model to build anything.

This library defines the audio format shared by browser capture and API validation.
PCM means a sequence of sound samples; WAV adds a small header describing them. Wrenly
accepts one channel at 16,000 samples/second, encoded as signed 16-bit numbers. Restricting
that format avoids accepting arbitrary compressed media at the native model boundary.

- `pcm.ts` resamples browser audio with a low-pass filter, which removes frequencies
  that would otherwise turn into false lower tones when reducing the sample rate.
- `wav.ts` writes and independently checks the exact header, size and duration.
- `transcript.ts` bounds the returned text and rejects invalid/control characters.
- `limits.ts` holds shared recording and response limits.

This package performs no recording, uploads, storage or transcription. Those belong to
the browser capture controller and the API's separate transcription adapter. It has no
runtime dependencies and works without network access. CLI runtime and microphone UI
are separate implementation steps; this library does not enable voice input by itself.
