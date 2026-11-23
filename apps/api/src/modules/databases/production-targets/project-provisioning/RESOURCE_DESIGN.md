# From completed SQL to a ready project resource

COMPONENT: Production resource handoff and readiness
PURPOSE: Make SQL creation part of the existing resource journal without treating it as proof that applications can connect.
INPUTS: Exact completed creation, original server revision, active project owner, encrypted role credentials and a durable resource claim.
OUTPUTS: Pending resource and create operation; ready only after verified role policy, isolated reader query and settled cleanup.
STEPS:

1. Under ordered locks, verify every SQL phase acknowledged and the original project access/server identity unchanged. Atomically attach the creation to one Production resource and create operation.
2. Re-encrypt the same role credentials under the ordinary resource identity. Generate no replacement passwords. Keep the immutable server binding separate from local Development Docker identity.
3. Workers claim only their configured provider. A local worker cannot claim a remote resource or decode its credentials as local PostgreSQL.
4. Hold the resource execution lock and current owner authority. Verify the original cluster, minted password proofs, role privileges and initial schema over pinned private TLS.
5. Record network intent, create a labelled broker network, save its exact Docker ID and separately acknowledge it. Never adopt an existing name automatically.
6. Open the reader broker, run the trusted bounded query helper with no IP network, and record independent socket cleanup. Recheck server/schema before saving readiness metadata.
7. Ordinary completion requires the Production binding, verified schema digest and role-verification acknowledgement. Failure preserves pending/uncertain work for inspection; it never retries SQL or marks the resource ready optimistically.

EDGE CASES: Session/access loss, uncertain network creation, wrong environment labels, changed grants, TLS/DNS drift or cleanup failure blocks readiness. Public-root certificates use verify-full and the toolchain CA store; custom CA chains remain explicitly reviewed and bounded.
ERROR STATES: Safe phase labels explain which verification could not be confirmed without returning SQL, credentials or raw provider failures. The factory remains unregistered until the full Production data and publishing lifecycle is connected.
