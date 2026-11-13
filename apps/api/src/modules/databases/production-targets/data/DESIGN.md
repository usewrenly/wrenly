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

COMPONENT: Per-project Production stop/start
PURPOSE: Pause one generated app's database without stopping the shared PostgreSQL server or another project.
INPUTS: Explicit owner action with current resource revision and immutable cluster/database binding.
OUTPUTS: Confirmed stopped/ready state, preserving stored data and role passwords.
STEPS:
1. Admit stop only for ready resources and start only for stopped resources; retain all ordinary active-work blockers.
2. Under the resource lock and renewed claim, verify the maintenance connection's cluster and exact project ownership/restricted roles.
3. Stop records intent before disabling new connections and terminating only sessions attached to that exact project database; confirm none remain before acknowledgement.
4. Start records separate intent before enabling the same database, then verifies original role policy and schema before marking ready.
EDGE CASES: Never stop the cluster/container, adopt a renamed database, rotate credentials or silently retry an uncertain availability change.
ERROR STATES: Unexpected previous state, foreign ownership or unconfirmed cleanup stays blocked for explicit inspection.

COMPONENT: Production read-only viewer socket
PURPOSE: Let authorized project members inspect schema and owners inspect rows through the existing bounded viewer.
INPUTS: Current session, exact ready resource/environment/revision and a running read lease.
OUTPUTS: Reader-only socket and role for the trusted query helper; no management or migrator credentials leave the adapter.
STEPS:
1. Reuse the existing viewer authority checks before decrypting anything; freeze the read's own session/access revision.
2. Resolve only the original attached project's immutable server and project binding, then verify private TLS, cluster, restricted roles and schema.
3. Open the reader socket under the resource lock/read lease; retain all browser cancellation and independent closure behavior.
4. Return only bounded validated data after the existing final authority check.
EDGE CASES: Members may read schema, but Production rows remain owner-only. Revoked/restored sessions and changed access revisions cannot reuse a read.
ERROR STATES: Unknown query/socket effects retain the saved recovery blocker and suppress all output.

COMPONENT: Effect-free Production interruption recovery
PURPOSE: Release an owner-reviewed action that provably never reached an external effect.
INPUTS: Exact interrupted operation/current resource revision and current project owner confirmation.
OUTPUTS: Failed original action plus a separate successful recovery receipt; no job replay.
STEPS: Reuse ordered recovery locks and resource kernel lock; accept only a complete verified Production binding for existing resources, no primary/cleanup intents or acknowledgements, then record failure and restore the prior ready/stopped state.
EDGE CASES: SQL creation handoff/network creation and any partial action remain inspection-required; Production creation cannot use this shortcut.
ERROR STATES: Missing/foreign binding or any effect evidence preserves the blocker. This does not resolve unknown migrations or connection changes.

COMPONENT: Read-only Production availability recovery
PURPOSE: Confirm the result of an interrupted project stop/start without repeating it.
INPUTS: Current owner confirmation, exact interrupted effect ID, preserved project/server binding and resource revision.
OUTPUTS: Separate recovery receipt after actual connection state matches the original request.
STEPS: Hold the existing recovery resource lock; verify immutable cluster, restricted role flags, database ownership and connection grants through the maintenance connection; stopped requires no sessions, ready additionally requires unchanged original schema and role policy; compare only the exact saved availability effect before releasing the blocker.
EDGE CASES: Another project's database, altered grants, a missing intent or any unrelated effect cannot be adopted.
ERROR STATES: An unreachable or mismatched server preserves the blocker. Recovery performs no availability DDL, SQL replay, restore or password replacement.

COMPONENT: Production disposable-rehearsal recovery
PURPOSE: Release a failed local rehearsal only after its disposable resources are removed and the original Production schema is verified unchanged.
INPUTS: Current owner, exact interrupted operation, verified matching backup, immutable Production binding and resource revision.
OUTPUTS: Failed original migration and a separate successful recovery receipt; no migration replay.
STEPS: Reuse the existing resource lock, current-authority checks and ordered recovery journal; accept only the exact nine local restore effects before an unacknowledged disposable migration; independently clean the disposable scope; inspect the original private TLS database and role policy read-only; compare its saved schema/native journal digest before completing recovery.
EDGE CASES: Production never uses a Development runtime identity or starts a stopped database. Prior interrupted recovery cleanup is checked independently.
ERROR STATES: Missing binding, changed schema, unavailable server, unknown effects or uncertain cleanup preserve the blocker.


COMPONENT: Production backup/migration outcome recovery
PURPOSE: Clean only one interrupted operation's temporary clients and determine its original database outcome without repeating SQL.
INPUTS: Current owner/session, exact interrupted backup or migration and current resource revision, pinned original binding and frozen migration review.
OUTPUTS: Independent cleanup and inspection receipts; failed backup/unchanged migration, or separately evidenced applied migration.
STEPS:
1. Acquire the original resource's kernel lock and a durable recovery lease; preserve old intents and forbid unrelated active work.
2. Recognize only fixed operation-owned helper names/effects. Remove exact label-verified temporary helpers/socket/disposable restore; terminate only that resource's migrator sessions through pinned TLS.
3. Inspect immutable cluster/database/role policy and actual schema/native journals. Backup requires the unchanged saved digest; migration accepts only its frozen before or successfully rehearsed after digest.
4. Recheck owner, resource revision/binding and all frozen operation/review evidence in one completion transaction. Cleanup receipts do not acknowledge SQL; only an independent exact after-digest may establish an applied migration.
5. Preserve original unknown effects and recovery history. No backup is called verified merely because cleanup passed; an unchanged migration stays failed. Unknown or partial schema remains blocked.
EDGE CASES: Lost cleanup or final-save replies retain an independently replayable recovery identity; no automatic SQL or archive capture retry. Missing/foreign helpers, changed targets or journals refuse completion.
ERROR STATES: Unreachable target, stale authority, uncertain cleanup or nonmatching schema keeps recovery required.
