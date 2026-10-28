# Durable disposable validation

A generated booking app is tested against a new empty database, never the user's
reservations. If the API stops halfway through, the next process must know what it
started and must not repeat uncertain work.

COMPONENT: Build-owned database validation record
PURPOSE: Save exact source/image identity and external-effect/cleanup state before validation.
INPUTS: A live build claim, explicit local Development resource/revision, prepared image,
        migration digest, operation/request IDs and remaining build time.
OUTPUTS: One running database-operation claim and frozen validation details, or a refusal.
STEPS:
1. Lock global work queues, current actor account/project, then build/resource records.
2. Require the submitting actor's current contribution authority and live build token.
3. Revalidate saved source, freeze all file bytes and record their fingerprint.
4. Reject conflicting database work; register a running operation, never queue a retry.
5. Persist source/image/deadline/access identity separately from persistent database state.
6. Recheck both parent build and validation leases plus source/access/resource identity
   before external effects. Save mutation intent and cleanup intent independently.
7. Success requires confirmed cleanup and the exact migration/schema result; finishing
   validation must never replace the real resource's runtime identity or schema.
EDGE CASES:
- Replayed admission returns a conflict requiring inspection, never a fresh execution token.
- Parent cancellation, changed source or access, expired leases and old claims stop effects.
- Cleanup may acknowledge removal while the primary effect remains uncertain.
ERROR STATES:
- Unknown work remains interrupted and blocks new conflicting actions.
- No factory or schema change activates a database worker, route or build path.

Ordinary build execution and runtime integration must be wired and accepted before
this can be activated.

## Execution and completion continuation

The executor holds the existing resource kernel lock and renews a separate cleanup
lease. New generated work still requires the live parent/source/deadline checks;
cleanup ignores user cancellation but remains bound to that lock, its own live claim
and a fixed 60-second post-deadline allowance. No cleanup can create more app work.

Primary effects use the existing intent/acknowledgement journal without saving any
disposable runtime identity on the real resource. Cleanup uses separate exact names
for application, socket and disposable database; its acknowledgement never clears an
unknown primary effect. Success requires all cleanup receipts, matching migration and
schema fingerprints, current parent authority and expected execution receipts. Failure
with uncertain effects stays interrupted. The executor never retries the attempt.

## Explicit recovery

The current owner selects an interrupted validation after its parent build settles.
Recovery reserves a separate operation under the same resource lock and records each
cleanup intent before inspecting exact operation-labelled application, socket and
database resources. Confirmed absence resolves the blocking operation but preserves
its uncertain original effect for inspection. It never reruns source or SQL. Exact
request replay returns the saved recovery receipt; a failed recovery requires a new
explicit request. Resource identity, schema and revision remain unchanged.

## Preparing database-backed source

Preparation installs dependencies under the existing restrictions and compiles source
without database access. Laravel's ordinary stateless validation still probes HTTP;
the explicit database preparation path postpones that probe until migrations and a
role-scoped socket exist. It requires a matching reviewed migration manifest. Ordinary
artifact publishing rejects declared database source rather than treating compilation
alone as proof of a working database-backed application.

## Owning preparation before Docker starts

COMPONENT: Build-owned preparation and validation lifecycle
PURPOSE: Make a crash during dependency installation or image creation recoverable.
INPUTS: Live parent build, exact saved source and explicit Development resource selection.
OUTPUTS: Saved validation evidence after preparation, runtime checks and artifact cleanup.
STEPS:
1. Register the validation before preparation with no image and an explicit artifact-owner flag.
2. Under the resource lock, record a preparation effect before Docker; use the operation ID
   for every preparation label. Keep the original deadline across preparation and validation.
3. Save the resulting immutable image and acknowledge preparation atomically. Refuse a
   second preparation or replacement image; uncertain preparation is never automatically rerun.
4. Run the existing validator, then independently remove preparation resources and its
   retained image before completion. Caller-owned legacy images remain the caller's job.
5. Explicit interrupted recovery cleans the same labelled artifact scope, even if image
   acknowledgement was lost, without installing dependencies or repeating application code.
EDGE CASES:
- A crash before the image ID is saved still leaves an operation-labelled cleanup scope.
- Cancellation leaves cleanup authorized under the bounded cleanup claim, not new app work.
- Image references or foreign ownership refuse deletion and preserve the interruption.
ERROR STATES:
- Lost preparation acknowledgement keeps its primary effect unknown after cleanup.
- Missing artifact cleanup receipt prevents owned-attempt success.
This extends the approved disposable validation lifecycle; it does not activate build selection.

## Saved-build handoff

The handoff accepts only the original build claim and explicit operation/resource/
revision/deadline selection. It resolves the actor from the claimed job and source from
the exact saved build, derives the migration identity locally, then uses the owned-
preparation lifecycle. Caller-provided source, image, actor and secrets are rejected.
An interrupted result remains distinct from a known validation failure and must not
enter the model's repair loop. Selection is now frozen through trusted internal build
admission and checked against the live saved job. Ordinary HTTP/conversation admission
does not yet supply it; this helper does not infer a resource from generated text.

The database-aware validator is constructed explicitly and starts no work by import.
No selection delegates to existing stateless validation; malformed manifests remain
repairable source failures. Interrupted database outcomes throw a dedicated fixed
build interruption, which survives the build executor and is recorded by the worker
after cleanup. Safe model guidance is versioned-selection dependent and contains only
manifest/framework/environment-key instructions, never live rows or connection values.
Installing this adapter in production still requires the remaining activation gates.
