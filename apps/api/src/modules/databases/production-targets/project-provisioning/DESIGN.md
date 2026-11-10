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
