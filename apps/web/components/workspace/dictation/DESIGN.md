COMPONENT: Private bounded microphone capture
PURPOSE: Gather mono samples only after an explicit recording action and stop every audio resource reliably.
INPUTS: User recording action,microphone permission and actual AudioContext sample rate.
OUTPUTS: Canonical WAV on explicit Stop; cancellation returns no recording.
STEPS:

1. Check secure context and supported browser APIs before requesting microphone access.
2. Track a cancellation generation across asynchronous permission/context/module loading.
3. Load a same-origin generated AudioWorklet module; bound sample accumulation in both
   worklet and controller. Bound elapsed time independently of browser timer frequency.
4. Capture only channel data; route silent worklet output to the destination to keep
   processing active without replaying the microphone to speakers.
5. On Stop disconnect nodes,stop all tracks,close context,revoke module URL,then resample.
6. Cancel immediately discards buffers; a late permission result must stop its tracks.
   EDGE CASES: Denied permission,unsupported browser,device removal,late permission,background tabs.
   ERROR STATES: No recording on failed/cancelled setup. Controller does not fetch,transcribe,
   insert a transcript or submit any prompt; those belong to the review UI lifecycle.
