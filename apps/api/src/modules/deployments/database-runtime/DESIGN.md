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

COMPONENT: Production route verification
PURPOSE: Accept a published URL only after independent host and HTTP proofs.
INPUTS: Saved route-verification intent, prior broker/service/app acknowledgements,
trusted ingress image, fixed provider client and current publishing fence.
OUTPUTS: Credential-free URL/source acknowledgement after exact deployment marker verification.
STEPS:
1. Require the saved composition digests and all earlier runtime identities.
2. Read the exact service and allow a single ingress domain only; reject direct app exposure.
3. Re-inspect the broker, generated app and credential-free ingress through the fixed host helper.
4. Require all three running and the broker socket ready; probe the public root and deployment marker without credentials or redirects.
5. Recheck the publishing fence before returning the safe acknowledgement.
EDGE CASES: A missing route or not-ready HTTP endpoint can be polled within the worker's bounded deadline. No provider mutation is retried.
ERROR STATES: Changed isolation, ambiguous routes, foreign marker or cancelled claims preserve pending intent.

COMPONENT: Production runtime service composition
PURPOSE: Connect the durable coordinator to the real store and fixed host/provider adapters without activating startup.
INPUTS: Current deployment claim, worker lock/lease fence, verified artifact/toolchain identities and fixed provider placement.
OUTPUTS: One coordinator whose effects always follow persisted intent and current runtime credential checks.
STEPS:
1. Reuse the store's binding/journal, intent and acknowledgement transactions.
2. Reload claim-bound runtime credentials immediately before each selected effect.
3. Dispatch provisioning and service mutations once; never retry these calls.
4. Poll only read-only container discovery and route readiness, under a deadline and the current publishing fence.
5. Preserve any pending effect when shutdown, identity drift or deadline prevents confirmation.
EDGE CASES: Composition alone does not enable database publishing or bypass artifact preparation/admission/recovery gates.
ERROR STATES: Missing credentials/configuration, unsupported effects or lost leases stop the coordinator with its journal intact.

ACCEPTANCE: A disposable TLS PostgreSQL fixture and the real host helper actions
must join a trusted guardian, unprivileged HTTP relay and runtime-only broker.
Perform HTTP create/read/update/delete and prove stored data survives application
replacement. Keep fixture credentials out of container configuration and prove the
app has no IP network and the relay has no database socket. This is local runtime
acceptance; actual framework and Coolify deployment acceptance remain separate.

COMPONENT: Interrupted setup-effect reconciliation
PURPOSE: Confirm an uncertain socket-volume or broker-network creation without creating or deleting anything.
INPUTS: Settled interrupted deployment, original pending setup effect, current saved owner/session authority, exact host binding and kernel/lease fence.
OUTPUTS: One acknowledgement of the original effect when exact read-only proof succeeds; absent/foreign/unreadable evidence retains interruption.
STEPS:
  1. Take the publishing kernel lock and a fresh short verification claim under the existing queue/account/project locks.
  2. Permit only the original pending HTTP volume, database volume or broker network phase. Preserve the original effect ID/token and completed receipts.
  3. Authenticate saved host credentials under that claim, then invoke only fixed inspect actions.
  4. Verify daemon, nonce, exact deterministic resource name and strict helper response; absence is not success.
  5. Save the matching original receipt, then release verification ownership back to interrupted status. Never resume later remote mutations implicitly.
EDGE CASES: A newer receipt/claim or changed source/schema/host/session refuses recovery. A lost local acknowledgement is inspected again rather than repeating creation.
ERROR STATES: Missing or mismatched resources remain blocked. Later credential/service/SQL phases are outside this inspector and cannot be cleared through it.
