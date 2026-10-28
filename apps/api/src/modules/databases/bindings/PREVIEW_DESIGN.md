# Saving the database choice before preview preparation

Gateway continuation: a declared database preview must pass the same current binding
check when issuing/consuming its grant and on each gateway session request. Require
ready/unexpired state, no cleanup ownership or pending runtime effect, all three exact
ordered runtime confirmations, matching prepared image/socket and current source/schema
evidence. This does not grant a viewer contribution authority: it verifies the original
executor's authority separately from the existing viewer/session checks. Stateless
source does not read the inactive database module's tables. Any declaration or evidence
error denies access, without starting work, decrypting credentials or repairing state.

A booking-app preview must use the selected saved code and the Development schema
reviewed for that code. A successful old build cannot authorize an unrelated database.

COMPONENT: Preview database reservation
PURPOSE: Save exact validated code/schema evidence atomically with preview admission.
INPUTS: Current contributing actor, successful build, explicit ready Development choice and request key.
OUTPUTS: One preview plus immutable non-secret database evidence, or no reservation.
STEPS:
1. Trusted internal database admission acquires all queues before account/project/resource locks.
2. Keep ordinary stateless admission unchanged; declared database source requires the explicit path.
3. Match the build's admitted resource identity, current ready revision, applied migrations,
   full-source validation and current access; lock the resource before saving both rows.
4. Exact request replay returns the saved reservation only if build/resource selection agrees.
5. Reusing an active preview requires identical saved database evidence; no implicit replacement.
6. The ordinary preview worker skips declared database source until its runtime adapter is installed.
EDGE CASES:
- Persistent migration can advance the resource revision after build validation; use current reviewed schema evidence.
- Stale resource, changed source/access/schema, unresolved work or a mismatched replay refuses admission.
ERROR STATES:
- Any failed check rolls back preview/request/binding insertion together.
- The reservation grants no socket/credentials; runtime and gateway checks remain separate required gates.
This is part of the approved database lifecycle, not activation of its HTTP/UI/runtime path.

The explicit database claim repeats these checks before changing queued to preparing.
It uses the shared preview lease duration and returns only saved files and validated
evidence. A stale reservation stays queued for review; neither the database claim nor
ordinary claim starts Docker. The ordinary claim skips database manifests and can
still select a stateless reservation within the existing bounded capacity.

Runtime callers use assertPreviewDatabaseBinding before effects. It checks current
lease/status/expiry, absence of completed cleanup, exact frozen preview bytes, the
submitting contributor's current authority and fresh full validation/schema evidence.
It never decrypts credentials or opens sockets. Those runtime operations require their
own independent effect/cleanup lifecycle before production installation.
