# Saving a disposable validation attempt

A build might test whether its booking app can start after creating its tables in
an empty database. Before that test starts, Wrenly needs a saved record of exactly
which source and prepared image are being checked. Otherwise a restarted process
could accidentally validate different code or repeat an uncertain operation.

`validation-store.ts` registers a **running** `validate-application` operation tied
to the submitting actor's live build claim. The separate validation row saves the
file bytes, their fingerprint, migration identity, immutable image ID, resource and
sharing revisions, and remaining deadline. A repeated request is refused for explicit
inspection; it does not return another execution token.

Authority checks require both leases (the short-lived build and validation claims),
current contribution permission, unchanged source/resource/access and an uncancelled
parent build. Frozen inputs load only for a matching executor. An unresolved validation
also blocks another disposable validation even on another project, so temporary
resources cannot accumulate unnoticed.

This record never changes real application data or resource identity. The shared
operation journal can save external-effect intent, but cannot use ordinary resource
completion or copy a disposable runtime identity onto the real Development resource.

Migration **0031** creates this internal metadata table; **0032** adds preparation
ownership and permits an initially absent image. Neither is queried by ordinary
API startup and does not enable database-backed builds.

`beginDatabaseValidationPreparation` saves the source and cleanup owner before Docker
starts. The executor records preparation intent, compiles the source without database
access and saves the image together with its acknowledgement. It uses the original
deadline for both preparation and validation. A lost reply never means “try preparing
again”; recovery removes the operation-labelled workspace and image instead.

Owned attempts remove their image before completion. The older internal
`beginDatabaseValidation` entry accepts a caller-owned prepared image and leaves its
cleanup to that caller; it is not used to bypass preparation ownership in the new path.

`build-validation.ts` provides the internal build handoff. It accepts a live build
claim and explicit resource/revision/deadline, then reads the submitting user and source
from that job's saved records. There is no actor, source, image or credential override.
The helper returns an interrupted outcome when preparation cannot be confirmed; the
build caller must stop repair retries in that case. Replaying its operation/request
cannot start preparation again. Ordinary worker startup does not call this helper yet:
the product must first expose and connect an explicit resource choice. The handoff now
requires that choice in the saved job's `databaseV1` and compares it with the claim and
requested resource before preparing anything. Trusted internal admission can freeze
this snapshot. Ordinary build/conversation admission can now freeze an explicit choice
under a trusted activation permission. Production keeps that permission disabled.

`validation-executor.ts` runs the saved attempt while holding the resource's process
lock. It checks the parent build before generated work, records effects before they
start and requires separate cleanup receipts before accepting success. Cancellation
stops new application work but allows bounded cleanup to continue under its own live
claim. `validation-effects.ts` keeps those completion rules together.

An interrupted validation retains its blocking operation without marking the real
Development resource as damaged: all generated work targeted a disposable resource.
Expiry recovery does not requeue it. `validation-recovery.ts` lets the current owner
explicitly remove the old attempt's precisely labelled disposable resources after
the parent work settles. It never repeats migrations or runs application code. A
replayed recovery returns its saved acknowledgement rather than running again.

## What the tests establish

`build-guidance.ts` adds safe framework instructions only when a build has the versioned
selection. It names the manifest and standard environment keys, never resource IDs,
rows or connection values. Existing stateless prompts receive no database guidance.

`build-validator.ts` is the explicit adapter factory for the remaining worker wiring.
It keeps unselected builds on the existing stateless validator, treats an invalid
manifest as a repairable source error and throws `BuildExecutionInterruptedError` for
uncertain execution. The build executor preserves this error instead of starting another
model attempt; the worker records interrupted after cleanup. Production worker composition
installs this adapter only with the Development database opt-in. An inactive
worker fences a saved database job before any model or validator call. Its controlled unit tests are separate from real
Docker acceptance and do not claim end-to-end product activation.

PostgreSQL acceptance checks frozen source, cancellation, lost claims, uncertain
effects, explicit recovery and protection of the real resource. Controlled execution
tests exercise the durable journal without claiming to run an application.

With `WRENLY_TEST_APP_DATABASE_VALIDATION_RUNTIME=true`, the same suite also prepares
real Next.js and Laravel images and invokes the real executor. Each fixture migrates
an empty disposable database, creates/reads/updates/deletes a row, serves an HTTP page
and removes its temporary resources. A separate Docker cleanup test verifies that
foreign labels and the persistent source volume cannot be removed.

Ordinary build selection, preview runtime
bindings, viewer activation and Production publishing remain separate integration
gates. These tests do not make the database feature available in the product.

The binding module's `readValidatedDatabaseRevision` connects successful evidence to
the later compatibility read. It compares both the frozen validation files and current
saved build files using the same full-source fingerprint. This prevents a page edit
with unchanged migrations from borrowing an older application test.
