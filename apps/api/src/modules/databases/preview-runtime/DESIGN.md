# Owning a database preview's runtime work

Host continuation: an explicit production factory requires local previews enabled,
Linux host execution, current database-preview persistence, trusted cached toolchains,
actual isolation probes and a kernel-lock handshake before starting the loop. Bind
ingress capabilities to preview/claim with the existing instance auth secret. Hold
one original kernel lock per claim, including an external-request settle window for
dead-executor recovery. Stop awaits the scheduler and then releases quiescent locks;
failed cleanup remains reserved in PostgreSQL even when its host lock is released.
Construction is not wired into index.ts until HTTP/UI and activation gates are ready.

Worker continuation: an internal dependency factory connects database claims to the
existing bounded preview scheduler. Hold the exact local kernel lock before preparing,
monitoring or cleanup; renew only after checking current database binding. Prepare image,
open socket, start app/ingress, then mark ready only after journal confirmation. Monitor
current binding and native container liveness; no raw generated logs are collected.
Recovery selects only saved database bindings, proves prior executor quiescence outside
transactions, revokes expired live state under ordered locks, then independently cleans.
Ordinary recovery must skip declared database source. A prior cleanup token or failed
cleanup is never automatically retried/replaced; retain capacity for explicit recovery.
Importing/constructing the factory starts nothing and does not install production routes.

Persistent startup continuation: authenticate the existing instance database key against
the selected resource's encrypted credentials before deriving a Development-only Laravel
application key with HKDF-SHA256. Fixed versioned purpose plus project/resource identity
separates it from Production and every other database. Code/schema/preview changes do
not change it; restoring the resource requires its existing instance key as before.
Never generate a replacement when that key is missing. The derived key is process-local
and delivered only with runtime-role credentials to the trusted preview bootstrap.

Load the acknowledged image/socket from the journal, record start-application intent,
then call the prepared-image sandbox adapter. Persist its exact app/ingress resources
through the existing starting transition; acknowledge startup only after ingress HTTP
readiness. Before each mutation recheck claim/kernel/source/schema. Any lost effect
interrupts and retains resources for independent cleanup, without restarts or stateless
fallback. Worker installation still requires combined lifecycle acceptance.

Preparation continuation: load the preview's saved files from persistence, not caller
memory. Match complete-source identity and framework against current validated binding.
Record preparation intent before invoking the existing offline database artifact
preparer with the preview UUID and exact migration digest. Recheck signal, kernel and
binding at every adapter mutation and before acknowledging its immutable image ID.
Return no credentials. A lost reply interrupts the preview and retains the preparation
target for independent cleanup; never rebuild or adopt an earlier image on retry.

Cleanup sequence continuation: an explicit caller supplies an already acquired cleanup
claim and its own shutdown signal, not the cancelled application's signal. Under the
existing kernel lock, read the durable cleanup receipts as an exact ordered prefix.
Reject foreign/duplicate/out-of-order receipts or a pending target other than the next
step. Renew only the existing bounded lease, then invoke the next application/socket/
sessions/artifact controller once. Each controller records and confirms its own effect.
Stop on abort, lost authority or any uncertain result; never catch and retry a removal.
On explicit recovery, skip only exact saved confirmations and resume the pending step.
Release capacity only through the existing transactional finish check. This connects
internal cleanup only; it neither acquires replacement authority nor activates workers.

A booking preview may stop after opening its database socket but before the API saves
the result. Cleanup must know what was attempted without starting the app a second time.

COMPONENT: Database preview runtime journal and role delivery
PURPOSE: Persist preparation/socket/application intent and independently fenced cleanup.
INPUTS: Exact preview claim and validated binding, held preview kernel lock, instance key directory.
OUTPUTS: Saved non-secret runtime identities; application-only credentials delivered server-side.
STEPS:
1. Create an empty runtime journal atomically with the explicit database preview claim.
2. Before each effect, check the live preview/binding and kernel lock; save exact target intent.
3. Acknowledge preparation/image, socket or application only against matching pending intent;
   record immutable IDs and refuse overwrites or repeated execution.
4. Load encrypted credentials only after current binding checks, validate every role's
   resource identity and return only the runtime role. Never return administrator/migrator/reader secrets.
5. Cleanup has a separate bounded token/lease/deadline under the same kernel lock. It can
   close a stopped/interrupted preview despite revoked user access, but cannot execute code.
6. Save separate application/socket/session/artifact cleanup intents and receipts. Confirming
   cleanup never acknowledges the original unknown effect. Retain reservation until every
   required cleanup is confirmed; expired cleanup ownership is not silently renewed.
EDGE CASES:
- A lost image/socket acknowledgement leaves its intent available for exact labelled cleanup.
- A live cleanup lease blocks another cleanup owner; reacquisition requires explicit quiescence.
- A source/access/schema change blocks application work, not narrowly scoped cleanup.
ERROR STATES:
- Unknown work stays recorded; neither this journal nor credential loading starts Docker.
- Runtime adapter and actual cleanup/session termination remain required before activation.

Socket continuation: an explicit controller records create-socket before role delivery,
checks every sandbox callback against the fixed target and saves the returned identity
only after readiness. Unknown startup interrupts without retrying. Scoped socket cleanup
uses the independent cleanup claim and rechecks it before every Docker removal; partial
cleanup retains its pending receipt. Application/ingress and session termination remain
uninstalled. Application acknowledgement must match the exact prepared image, and all
kernel-fence callbacks are awaited, including asynchronous failures.

Cleanup ordering continuation: enforce application → socket → sessions → artifact
at both intent and acknowledgement. Each prerequisite must name this preview's exact
saved target. An unresolved earlier removal, a receipt for another preview or a duplicate
completed category cannot authorize the next effect. A pending exact intent remains
recoverable under replacement cleanup ownership. This prevents a session confirmation
from preceding the shutdown that stops the application reconnecting.

Application cleanup continuation: record the original preview's application cleanup
intent before calling the trusted preview remover. Pass an awaited independent cleanup
fence into that remover before discovery, each Docker deletion and host workspace
removal. Save acknowledgement only after removal and a final claim check. A failed
removal retains intent and capacity; never release the original kernel lock here because
socket/session/artifact cleanup still needs it. This adapter does not start applications.

Session cleanup continuation: after exact application/socket cleanup receipts, save the
sessions intent. Under independent cleanup authority, verify the saved Development
resource/revision/runtime identity, authenticate its encrypted role bundle and pass it
only to the trusted administrator helper through stdin. The helper targets the exact
resource runtime role, never reader/migrator/administrator sessions. Resource-wide runtime
termination is safe only after the single project preview is stopped and its reservation
still excludes a replacement. Validate helper callbacks and acknowledge only after native
session termination and helper removal. Lost authority or unknown termination keeps the
pending receipt and capacity; revocation cannot prevent this narrowly scoped cleanup.

Artifact cleanup continuation: after application/socket/session receipts, record the
artifact cleanup intent and remove only preparation containers/workspaces and runtime
images labelled with this preview's original preparation UUID. Reuse the trusted shared
artifact remover (also used by disposable validation) with the independent cleanup
claim before every mutation. An unknown preparation acknowledgement still has an exact
UUID for discovery. Refuse image removal if live references remain; never force deletion,
touch the persistent database or mark an unknown original preparation successful. Save
the artifact receipt only after removal and a final fence check; capacity release remains
a separate operation requiring all four receipts.
