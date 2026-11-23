COMPONENT: Local speech execution adapter
PURPOSE: Bound one native recording execution and verify exact cleanup before accepting another.
INPUTS: Explicit verified model path,instance scope,canonical audio,request UUID and abort signal.
OUTPUTS: Bounded text or a safe unavailable state; no audio retained by host or Docker logs.
STEPS:

1. Verify local image revision/user and the pinned model's regular-file identity,length/hash.
2. At startup remove stopped containers carrying this exact instance/module/image identity.
   If a matching container is running, refuse activation instead of killing possibly
   active work from another API process. No hidden transcription retry.
3. Create a UUID-named,exactly labelled container with fixed resource and isolation options.
4. Attach via the explicit local Docker socket and send bytes while keeping stdin open.
5. On abort/deadline close input,then verify and remove the exact container and await attach.
6. Uncertain cleanup makes the adapter unavailable; never free capacity as if cleanup succeeded.
   EDGE CASES: Create response lost,name collision,retagged image,model replacement,API crash.
   ERROR STATES: Generic errors without audio/transcript/stderr. Configuration/runtime failures
   never affect typed conversation when dictation is disabled.
