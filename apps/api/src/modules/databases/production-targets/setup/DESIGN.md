# Saved Production setup verification

COMPONENT: Owner-confirmed Production setup admission
PURPOSE: Save one encrypted, replayable setup request before checking its remote credentials.
INPUTS: Active owner session, project/access revision, request UUID, explicit target confirmation and bounded connection credentials.
OUTPUTS: Actor-scoped setup receipt; credentials are never returned.
STEPS:

1. Check current owner access before creating/loading a separate Production setup key.
2. Lock work queues, account and project in existing order; check session/access revision and idle state.
3. HMAC the normalized request with the private key; identical UUID replay returns its saved receipt.
4. Save target identity and purpose-bound encrypted credentials atomically with queued verification.
5. Claim verification once with a lease and frozen actor/session; recheck authority before decrypting.
6. Only an exact claim may save verified facts or safe failure. Expired claims require inspection and never imply provisioning.
   EDGE CASES:

- Another account cannot read a receipt or decrypt the envelope; missing keys are never replaced over ciphertext.
- Changing target, credential or confirmation under a used UUID conflicts.
  ERROR STATES:
- Unknown acknowledgement uses receipt lookup. Verification is not resource readiness or permission to run provisioning SQL.

No routes or workers are activated by this storage module. Mutation-capable provisioning
will need its own saved phase intent and independent recovery before this flow is enabled.

## Executing a saved connection check

COMPONENT: Production setup verification executor
PURPOSE: Connect an exact saved worker claim to the private TLS inspector without provisioning.
INPUTS: Claimed setup, trusted control connection identity, instance key directory and cancellation signal.
OUTPUTS: Saved verified/refused/interrupted receipt, or an explicit unconfirmed completion error.
STEPS:
1. Load and decrypt only the live claim; read the control cluster identifier using a fixed read-only query.
2. Resolve and pin the private destination, excluding control-cluster addresses.
3. Authenticate with verified TLS and inspect fixed management metadata; await connection cleanup.
4. Recheck the original claim/session while saving safe facts. Never reinterpret a failed save as a refused remote check.
EDGE CASES: Cancellation records an interrupted check when the claim still permits it; expired claims remain reviewable.
ERROR STATES: No raw driver errors or credentials leave the executor. No retry, role creation, migration or ready-resource transition occurs.
