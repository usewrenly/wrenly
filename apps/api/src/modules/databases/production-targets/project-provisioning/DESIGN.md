# Saved per-project creation on the verified app server

COMPONENT: Project Production provisioning journal
PURPOSE: Create one project's database/accounts automatically after owner confirmation, without repeating uncertain SQL.
INPUTS: Current project owner/session, project access revision, exact verified instance connection ID, request UUID and server-generated credentials.
OUTPUTS: Immutable resource intent, separately acknowledged roles/database/grants/schema phases, or review-required outcome; no application-ready claim.
STEPS:

1. Lock queues/account/project, verify project authority, reject existing resource/work and freeze the exact latest verified connection revision.
2. Generate independent restricted role passwords once and encrypt them with project/resource/connection-bound authentication data.
3. Claim only cluster-mode requests. The older provider worker cannot claim these requests.
4. Retain the resource kernel lock and persist one phase intent before opening a verified private TLS connection or running fixed provisioning DDL.
5. Recheck saved authority, lease and immutable cluster identity; execute one fixed phase and separately persist its acknowledgement before advancing.
6. An unknown response or acknowledgement preserves its phase and blocks automatic repetition. Completed phases are never replayed.
   EDGE CASES: Connection updates never retarget existing requests; expired work needs explicit inspection; foreign existing database/role names are not adopted or reset.
   ERROR STATES: Unknown SQL remains review-required. A fully provisioned SQL resource remains distinct from runtime/broker readiness.

COMPONENT: Completed SQL resource handoff
PURPOSE: Continue an owner's saved creation into readiness without another browser click.
INPUTS: A completed cluster-mode SQL provision and its saved execution principal.
OUTPUTS: Exactly one ordinary pending resource/create operation, never an automatic ready state.
STEPS:
1. After all SQL phases are acknowledged, verify the exact resource kernel lock and release it before publishing the readiness claim; no SQL is replayable from created state.
2. Reuse the existing transactional attachment with the saved owner/session/access revision.
3. On restart, select only created provisions with no uncertain SQL effect and prove the prior kernel lock is released before the transactional attachment.
4. Let the existing readiness worker prove role/schema/socket identity before marking ready.
EDGE CASES: Lost attachment replies are safe exact replay; stale sessions require explicit owner review and never transfer ownership.
ERROR STATES: SQL uncertainty is not a completed handoff candidate. Refuse changed authority or incomplete evidence without replaying SQL.

COMPONENT: Project Production creation transport
PURPOSE: Let a project owner confirm creation and follow saved progress without seeing instance credentials.
INPUTS: Current authenticated principal, reviewed project revision, verified connection UUID and exact request UUID.
OUTPUTS: Bounded creation receipt/status and safe phase names; no host, passwords or role data.
STEPS:
1. Validate method, origin, IDs, bounded body and live session before transactional admission.
2. Reuse the existing owner/session/revision/provisioning store; never execute SQL in the HTTP handler.
3. Read progress by exact request UUID after a lost response; lookup never resubmits creation.
4. Project setup status exposes only the current verified connection UUID and project access revision to its owner.
5. Preserve queued/creating/created/attached/review-required distinctions; SQL completion is not readiness.
EDGE CASES: Old/changed connection or project revisions are refused. A missing exact request is distinct from an empty project status.
ERROR STATES: Unauthorized, malformed, changed or unconfirmed requests return fixed messages with private/no-store headers.
