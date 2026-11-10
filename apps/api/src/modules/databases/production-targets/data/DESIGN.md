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
