COMPONENT: Published runtime maintenance identity and eligibility
PURPOSE: Validate a separately confirmed permission for one already-verified publication before a worker may consider maintenance.
INPUTS: An explicit owner confirmation with immutable publishing receipts and separately loaded current account/project/resource/host evidence.
OUTPUTS: A validated non-secret grant and an allow/refuse decision; no database query, credential retrieval or external effect.
STEPS:
1. Require exact ordered complete publishing receipts and a matching owner/project access revision. The confirming login may differ from the original publishing login.
2. Freeze the original binding and receipts. The grant has an independent ID/revision and enabled/paused/revoked state.
3. Before use, compare the stored grant revision, live owner status/revision, project ownership/access/archive state, ready resource/schema and verified host placement, and current successful publication receipts.
4. Refuse conflicting work, revoked/paused permission, stale data or substituted containers/images. Return a safe reason rather than secret evidence.
EDGE CASES: Sign-out alone does not revoke a separately confirmed grant; account suspension or revision changes do. An expired publishing session is never reused as worker authority.
ERROR STATES: Missing or malformed evidence refuses maintenance. This pure contract never grants authority to a browser, starts a process or clears an uncertain effect.

Durable grant admission, audit, leases, remote proof, credential delivery, HTTP controls
and worker activation are separate callers. They must enforce current-session checks
when enabling/revoking permission and independently load current evidence under the
shared queue/account/project locks. Passing this pure validator alone is not authority
to start a container. Existing deployments receive no permission automatically.

Independent maintenance attempts use broker-start → application-start → route-verify.
Each transition requires the same unexpired claim and grant revision. A pending intent
blocks another start. Lease expiry preserves that intent as interrupted; it does not
reclaim it or resend credentials. Host proof and persisted transactions are mandatory
callers, not facts established by the pure journal.
