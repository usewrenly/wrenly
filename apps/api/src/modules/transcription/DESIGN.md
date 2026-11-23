COMPONENT: Explicit short-recording transcription
PURPOSE: Convert an authenticated bounded recording into text without admitting a prompt.
INPUTS: Same-origin authenticated request, canonical WAV and an injected transcription adapter.
OUTPUTS: Bounded editable transcript or safe failure, always no-store.
STEPS:

1. Validate origin and active session before acquiring a single local execution slot.
2. Reject disabled/busy requests before reading audio; bound streamed bytes and time.
3. Independently validate canonical WAV and pass only bytes,signal and request identity.
4. Recheck account access before returning text. Never log audio or transcript.
5. Release capacity only after the adapter settles; a cancelled client does not prove
   native cleanup. Adapter health must remain unavailable after uncertain cleanup.
   EDGE CASES: Upload abort,stalled stream,revoked session,malformed native response.
   ERROR STATES: Explicit status codes; no automatic retry or raw process diagnostics.

Production mounts the capability/upload routes and supplies a disabled adapter unless
the instance explicitly enables and verifies its local runtime.
The injected adapter contract owns process termination,90-second deadline and exact
cleanup; the HTTP handler must never release a still-running adapter by racing its
promise against an abort signal.
