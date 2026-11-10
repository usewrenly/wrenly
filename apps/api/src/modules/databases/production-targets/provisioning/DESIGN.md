# Durable provider creation

COMPONENT: Production provider creation journal
PURPOSE: Remember exactly one confirmed remote creation, including unknown outcomes, without marking a database ready.
INPUTS: Current owner/session/project revision, request UUID and server-configured provider ID and placement.
OUTPUTS: Non-secret receipt; an encrypted server-generated management credential; one fenced creation claim.
STEPS:
1. Under queue/account/project locks, verify owner/access revision and idle work. Save request and encrypted resource-bound credentials before any provider call.
2. Resolve the exact saved provider from an explicitly configured registry; never substitute a default. Claim queued creation once. Expired claims become needs-review, never queued again.
3. Acquire the existing per-resource kernel lock, recheck the claim and persist external-effect intent before sending POST.
4. Save only the returned remote UUID under the same live claim. A lost response remains needs-review; no automatic POST retry occurs.
5. Provider-created remains a project/member blocker until private TLS, SQL roles and runtime attachment finish their own phases.
EDGE CASES: Identical requests replay; configuration changes under one UUID conflict. Access changes and expired claims cannot decrypt or acknowledge.
ERROR STATES: Lost keys refuse replacement; unknown provider effects retain their request and credentials. Created is not ready. No startup worker or HTTP route is mounted by these helpers.
