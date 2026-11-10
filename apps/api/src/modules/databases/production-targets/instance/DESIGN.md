# One connection setup for the dedicated app server

COMPONENT: Instance Production connection revision
PURPOSE: Let the instance owner verify the app-only PostgreSQL server once, then let project resources retain its exact immutable connection revision.
INPUTS: Active owner session, request UUID, expected latest connection UUID (or null), explicit server confirmation, private target, management credential and optional CA.
OUTPUTS: Safe saved receipt and verification metadata; encrypted credential, no project database creation.
STEPS:

1. Serialize through existing database queue then lock/recheck account and instance ownership.
2. Replay an identical UUID; reject changed requests and stale expected connection IDs.
3. Refuse replacement during queued/running/interrupted database work. Preserve prior immutable revisions; never retarget existing resources.
4. Encrypt credential/CA with a separate instance-purpose key and bind target, owner and connection identity as authenticated data.
5. Claim read-only verification once, persist lease, decrypt only for that exact live owner/session/claim.
6. Persist only bounded authenticated cluster facts and canonical private pinned addresses; stale completion fails. A verified connection is not a ready project resource.
   EDGE CASES: Missing original keys fail closed; expired verification needs explicit acknowledgement before a new request; no automatic repeat or credential rotation.
   ERROR STATES: Safe fixed diagnostics; lost acknowledgements are read back, never converted into another remote operation.
