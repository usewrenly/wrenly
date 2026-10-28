# A project's database overview

COMPONENT: Owner resource actions and uncertain acknowledgement recovery
PURPOSE: Confirm Development setup/start/stop/backup while preserving one exact request across lost replies.
INPUTS: Authenticated actor/project identity, current status/capabilities and selected environment.
OUTPUTS: Explicit owner-reviewed POST, saved acknowledgement or a frozen pending request requiring inspection.
STEPS:
1. Restore a strict actor/project-scoped browser-session record; inaccessible/corrupt storage blocks writes.
2. Show only supported Development actions for current resource status; Production setup remains unavailable.
3. Confirm the action, freeze current revision and UUID, and persist its non-secret identity before POST.
4. Treat receipt as admission only, then clear the matching record and refresh actual activity.
5. Unknown results retain the record through close/reload/project/account changes. Lookup never executes work.
6. Missing lookup is not proof an in-flight POST cannot commit; only identical-request retry is offered.
7. A definitive first-attempt rejection can clear its record; a retry rejection cannot disprove an earlier unknown admission.
EDGE CASES:
- Another actor/project cannot adopt the pending action. A mismatched receipt cannot clear it.
- Closing/navigation cancels browser waiting, not backend execution. No automatic POST or retry on mount.
ERROR STATES:
- No session storage means no POST; no new UUID replaces a potentially submitted action.
- Migration review and interrupted-execution recovery need their own reviewed server metadata; basic controls do not guess them.

COMPONENT: Database overview
PURPOSE: Explain a project's separate Development/Production resources and show only server-confirmed status.
INPUTS: Project identity, loading/result state, shared bounded resource contract and explicitly supplied action callbacks.
OUTPUTS: Environment selection, resource/schema state, recent operation outcomes and role-appropriate controls.
STEPS:
1. Validate returned status with the shared browser-safe schema and match its project identity.
2. Show loading/unavailable states without retaining another project's metadata.
3. Keep Development and Production separate; changing tabs starts no request or operation.
4. Present real resource status and schema fingerprint; never invent tables, rows or successful setup.
5. Offer creation/management only with server manage capability and an installed callback.
6. Open Development rows only with the corresponding capability; Production opens schema first.
7. Display safe operation labels/outcomes, never internal effects, credentials or raw provider errors.
EDGE CASES:
- Empty resources, Viewer/schema-only access, stopped/recovery-required resources and stale project responses.
- Missing callbacks mean an action is not installed; mounting never creates or starts anything.
ERROR STATES:
- Malformed/cross-project responses render one safe retry surface, never partial data.
- Parent integration owns request cancellation, operation UUIDs, confirmation and uncertain-result recovery.
This is a presentation component for the approved resource workflow, not route/worker activation.

COMPONENT: Authenticated database workspace and read-only viewer
PURPOSE: Navigate confirmed schema and bounded rows without retaining stale application data.
INPUTS: Project identity, authenticated resource status, explicit resource/table/revision/view selection.
OUTPUTS: Schema table or text-only row page; loading/unavailable states discard visible previous results.
STEPS:
1. Request project status with session credentials, byte/deadline bounds and shared schema validation.
2. Open only an exact ready resource revision; background status refresh unmounts previous viewer data.
3. Query table names/schema first. A selected table is required before requesting rows.
4. Gate row controls by server capabilities; Production starts with schema and requires owner confirmation.
5. Key local read state by project/resource/revision/view/table/cursor and abort old requests on change/unmount.
6. Validate bounded responses against shared schema and requested table/rows mode. Never show cached rows on error.
7. Render cells as escaped text, distinguish NULL/empty values, and label samples/truncation honestly.
EDGE CASES:
- Permission loss, revision changes, rapid project switches and late responses cannot replace the selected view.
- No row cache, SQL console, generated links/HTML or write operations are introduced.
ERROR STATES:
- Failed inspection returns to resource status; it does not retry work automatically.
- Optional API registration remains absent from production until complete resource activation gates pass.

COMPONENT: Revision-bound migration review
PURPOSE: Let an owner inspect exact saved migrations and choose a verified backup before admission.
INPUTS: Explicit project/resource/build IDs, current owner session and resource revision.
OUTPUTS: Bounded migration text/hash identities and verified backup metadata, never secrets or execution.
STEPS:
1. Read under ordered project authority locks; require current owner and idle project.
2. Select only the requested ready Development resource and successful supported build in that project.
3. Validate saved source/manifest without running it; return exact migration content and digest.
4. List only restored verified backups of that resource whose backup operations succeeded.
5. Require explicit backup selection and confirmation; admission revalidates all bytes and revisions.
EDGE CASES: No manifest/backup, stale resource or denied access never becomes an automatic migration.
ERROR STATES: Fixed safe failures; reads start no Docker/SQL work. Production activation remains separate.

COMPONENT: Interrupted-operation review
PURPOSE: Offer inspection or cleanup from server-reviewed durable evidence without rerunning old work.
INPUTS: Exact selected operation, resource revision and current owner.
OUTPUTS: Explicit recovery confirmation with persisted request identity, or a refusal retaining the fence.
STEPS:
1. Read owner-only evidence under ordered authority locks; reveal no raw effects or runtime identities.
2. Distinguish an interrupted disposable validation on a ready resource from runtime/read interruption.
3. Offer only the corresponding inspection/cleanup path; the recovery service independently rechecks all effects and locks.
4. Preserve the same browser-session request/receipt rules used for normal actions.
EDGE CASES: Missing history, unsafe effects, changed revisions or unverified cleanup never become a generic retry.
ERROR STATES: Unsupported recovery remains blocked for operator inspection; no automatic execution on mount.

COMPONENT: Explicit database choice in ordinary build requests
PURPOSE: Accept a non-secret Development selection only when the trusted production composition enables it.
INPUTS: Existing build request plus optional shared resource/revision selection and server activation permission.
OUTPUTS: Frozen saved selection or refusal before persistence; stateless requests keep their existing identity.
STEPS:
1. Validate the shared selection; reject credentials, Production choices and retry overrides.
2. Reject browser choices while the feature is inactive and reject competing server/browser selections.
3. Include the explicit choice in request identity; reuse ordered admission and resource revision checks.
4. Optionally compose the existing disposable validator in the production worker; default remains stateless.
EDGE CASES: Explicit retry uses its saved choice; changed selections cannot reuse an idempotency key.
ERROR STATES: No fallback database or silent field stripping; this contract does not activate the product alone.

COMPONENT: Saved conversation database selection
PURPOSE: Carry an explicit Development choice through Auto/Plan discussion and atomic build admission.
INPUTS: Optional shared selection, current project contributor and server activation permission.
OUTPUTS: Nullable versioned selection persisted with the turn, reused only by its server-owned build action.
STEPS:
1. Keep omitted legacy selections stateless; refuse supplied choices while activation is disabled.
2. Freeze the ready resource/revision under existing conversation/account/project locks before saving the turn.
3. Include the choice in exact request identity and preserve it in worker claims.
4. Pass only the saved turn choice to atomic build admission; model proposals cannot replace it.
5. Revalidate current resource revision at build admission; Plan still cannot create a build.
EDGE CASES: Old turns have null selection; changed resources fail rather than silently selecting another database.
ERROR STATES: Invalid/stale choices save no new turn. The nullable column is introduced by a Drizzle migration.

COMPONENT: Explicit composer database selector
PURPOSE: Let a contributor choose a confirmed ready Development revision or deliberately remain stateless.
INPUTS: Authenticated actor/project, bounded status, optional shared selection and composer busy state.
OUTPUTS: Explicit non-secret selection included in the submitted conversation request.
STEPS:
1. Mount only when the trusted workspace composition enables the feature; default remains off.
2. Load actor/project-scoped status without creating resources or reading rows.
3. Show No database and only an authorized ready Development resource; never select it automatically.
4. Preserve stale/failed selections visibly until the user changes them; the server rechecks admission.
5. Save the selection with pending requests and return it in safe turn summaries so retry retains it.
EDGE CASES: Project/account changes cannot reuse local selection; Production and secret fields are refused.
ERROR STATES: Unavailable status cannot invent a ready resource or silently drop a saved request's database.

26 October recovery corrections: refresh status without unmounting the management
selection or an uncertain action. Closing an idle dialog clears its temporary review;
pending requests retain their saved identity. Only successful selected revisions may
open migration review. A background status fetch retains the last confirmed selector
label; actual errors/revisions still invalidate selection and server admission rechecks.
Failed reviews offer explicit read-only retry and a secondary Back to actions control.

26 October saved preview c701e946: the app's Postgres.js module chose DATABASE_URL and
an invented localhost fallback despite a managed PG* selection. Its list page then put
an API error object into array state. Known incompatible Postgres.js URL patterns now
fail source validation with fixed repair guidance; this does not claim comprehensive
static connection analysis and never replaces blocked Docker networking. Generation
and edit guidance require response.ok/shape checks and a visible retryable error state.
Existing saved revisions remain immutable; repair requires a new reviewed build.
