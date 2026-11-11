COMPONENT: Saved Production publishing runtime
PURPOSE: Tie every remote runtime effect to the exact successful source, database schema and reviewed deployment host.
INPUTS: Successful deployment/source identity, ready Production resource revision/schema/migration digest, verified instance connection/host/server and current owner session/access revision.
OUTPUTS: Immutable non-secret binding and ordered effect journal with strict safe acknowledgements.
STEPS:
1. Under the shared queue/account/project locks, verify ownership, ready resource, applied migration/source identity and exact verified host/server before saving a binding.
2. The publishing claim and kernel lock guard every execution; changing resource/host/source cannot retarget the saved deployment.
3. Persist one pending effect before a remote call; save its exact safe acknowledgement before advancing.
4. Preserve a pending effect on timeout or lost acknowledgement. Inspection may prove the saved effect; ordinary execution never overwrites or retries it.
5. Freeze the guardian app and ingress image digests before composition. Credentials are loaded only after current claim/session/resource checks and never enter the binding or journal.
EDGE CASES: Stateless publishing has no database binding and follows its existing executor. Legacy database revisions remain blocked until the new coordinator and acceptance gates are connected.
ERROR STATES: Invalid order, changed identities, expired claims and unresolved effects refuse execution. No automatic recovery or remote retry.

ADAPTERS: Host requests carry the saved effect UUID as their nonce and the exact
reviewed Docker identity. Verify strict replies before acknowledging any mutation.
Discover applications read-only by all resource labels, require exactly one match,
and independently inspect its image, mounts and isolation before delivering stdin.
Service requests use the frozen image digests and placement; no database credential
enters the provider payload. A missing or ambiguous match preserves pending intent.
