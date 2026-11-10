COMPONENT: Production resource actions and verified backups
PURPOSE: Run explicit owner actions using the immutable server binding and existing durable resource lifecycle.
INPUTS: Current owner/session, exact ready resource revision, request UUID and bounded action; saved credentials never come from the browser.
OUTPUTS: Safe replayable action receipt and, after verification, encrypted backup metadata.
STEPS:
1. Lock work queues/account/project, authorize the owner and current resource, and freeze this operation's session/access revision independently from setup's old session.
2. Claim only the remote provider. Renew the lease while holding the resource execution lock; check current authority before every helper effect.
3. Verify private TLS/DNS, immutable cluster and restricted project role policy. Start only the role-scoped socket needed by the action.
4. Backup capture runs network-disabled with credentials through stdin. Seal the archive and restore the authenticated saved bytes into a separately identified disposable Development database.
5. Compare restored schema/journal and unchanged source, then remove the disposable copy and independently close the source socket.
6. Save a verified backup record and finish only after all primary and cleanup effects are acknowledged.
EDGE CASES: A new login can admit a new action after setup's session expires. A saved request never borrows a later session silently. Stale/foreign bindings and unimplemented action kinds are refused before execution.
ERROR STATES: Unknown SQL/helper/cleanup outcomes remain interrupted; never overwrite live data, retarget the resource, replace passwords or repeat an uncertain action.

COMPONENT: Reviewed Production migrations
PURPOSE: Apply an explicitly reviewed saved revision after its verified backup succeeds on a disposable restore.
INPUTS: Exact resource/build/backup revisions, migration digest and current owner/session confirmation.
OUTPUTS: Matching rehearsal/persistent schema fingerprints and an acknowledged operation, or a preserved recovery blocker.
STEPS:
1. Freeze the same manifest/history/verified-backup review used by Development under ordered project locks.
2. Reuse the shared restore/rehearsal sequence; this copy uses separate local credentials and never connects to Production.
3. Recheck the original private TLS cluster, project role policy and pre-migration schema before opening one migrator-only socket.
4. Run the framework's fixed migration helper without IP networking; no model-selected commands or management credentials enter it.
5. Independently close its socket and terminate only this project's migrator sessions, retaining cleanup evidence separately from SQL effects.
6. Reapply restricted application permissions, protect framework journals and compare the persistent result to the rehearsal before completion.
EDGE CASES: Another project's credentials/database, rewritten applied migrations and stale backup/schema revisions are refused. Production uses a dedicated provider adapter, never a fabricated local runtime identity.
ERROR STATES: A failed or uncertain SQL acknowledgement cannot be cleared by successful cleanup. No automatic replay or live restore occurs.
