COMPONENT: Shared dictation audio format
PURPOSE: Give browser capture and API validation one small, predictable audio contract.
INPUTS: Mono floating-point samples at a supported capture rate, or canonical WAV bytes.
OUTPUTS: Bounded16kHz PCM16 WAV, validated samples or a plain safe validation error.
STEPS:

1. Reject excessive duration, unsupported sample rates and non-finite input before allocation.
2. Low-pass filter before downsampling; preserve duration and clip only when encoding PCM16.
3. Encode a fixed44-byte WAV header without optional chunks or codec containers.
4. Independently validate header lengths/rate/format/duration at the API boundary.
5. Bound and validate returned UTF-8 transcript text; grant no execution or tools.
   EDGE CASES:44.1k/48k capture,empty input,silence,clipping,malformed or trailing chunks.
   ERROR STATES: Invalid input never becomes an approximate accepted recording.

The package is pure TypeScript shared by browser and API. It opens no files, network,
microphone, process or model. Engine execution belongs to API transcription adapters.
