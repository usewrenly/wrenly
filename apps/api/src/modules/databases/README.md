# Databases for generated applications

A booking app needs somewhere to keep reservations. That database is separate from
Wrenly's own accounts, projects and conversation history. This module manages that
separate resource and the rules for letting generated code use it.

For example:

> Create Development → select it for a request → validate the generated app against a
> temporary database → review a backup and migrations → prepare a preview using saved data.

The Development workflow is explicitly enabled with `WRENLY_APP_DATABASES_ENABLED=true`
and requires local previews. The default is off. Production database provisioning and
database-backed publishing remain unavailable; Development is never promoted implicitly.

## Find the code

| Path | Responsibility |
| --- | --- |
| `production-module.ts` | Verify toolchains, stored credentials and locks; start and stop owned services |
| `http/` | Authenticated status, review, receipt, action and recovery boundaries |
| `database-store.ts` | Save requests, resource revisions, claims and external-effect acknowledgements |
| `production-database-worker.ts` | Execute the saved Development create/start/stop/backup/migration requests |
| `database-migration-review.ts`, `database-review-store.ts` | Bind exact saved migration bytes to an explicitly selected verified backup |
| `database-backup-*` | Encrypted archive storage and disposable restore verification |
| `bindings/` | Match selected builds and previews to the resource and applied schema |
| `validation/` | Test saved application source against a separate disposable database |
| `viewing/` | Role-aware bounded table/schema/row reads and owned reader cleanup |
| `preview-runtime/` | Prepare the saved app, deliver runtime-only credentials and clean owned helpers |
| `database-recovery*` | Inspect or clean interrupted work without repeating uncertain operations |

Shared browser-safe contracts live in pure `@wrenly/db/app-database-*` subpaths. Importing
those contracts does not create a control-database client or expose credentials.

## Saving a request before doing work

Admission means accepting a request into the saved work queue. It checks current access,
locks queues/accounts/projects in the established order and saves one request identity.
The receipt means accepted, not completed. A repeated identical request returns its saved
receipt; a changed request cannot reuse that identity.

A worker claims queued work with a token and a short-lived lease. The token identifies
its ownership; the lease must be renewed while it works. A kernel lock also prevents
another process from acting on the same resource while an old executor still exists.
Before an external operation, the worker saves what it is about to do. It separately
acknowledges the result and cleanup. Unknown effects stay blocked for explicit recovery.

## Building and reviewing schema changes

A resource existing does not select it. The user explicitly chooses a ready Development
resource/revision. Build and conversation admission preserve that non-secret choice;
Auto's build action reuses the saved value, and Plan cannot execute. Retries preserve
saved settings. Source changes and resource revisions are independently rechecked.

Generated source declares migrations in `wrenly.app.json`. Installation and compilation
have no database connection. Disposable validation owns a separate temporary database
and tests the saved app there. It never applies those changes to Development data.

The owner then reviews the exact successful revision and a restored, verified backup.
Migration execution rehearses the saved bytes against a restored copy, compares native
migration journals/schema and checks privileges before committing its result. Laravel's
identity binds the whole application because Artisan starts application bootstrap code.
No model/browser SQL console is exposed.

## Previews and viewing data

Preview admission derives only the resource saved with the selected successful build.
Reviewed migrations may advance that same resource's revision; current schema and exact
successful application validation must still agree. A different resource is never used
as a fallback. Stateless and database previews have separate claim/recovery paths and
share the existing capacity fences. The gateway checks current authorization and binding.

Generated containers retain blocked IP egress. Runtime and reader roles receive separate
authenticated Unix sockets. Database credentials do not enter generated files, Docker
Env/Cmd, browser responses or host plaintext files. The viewer returns bounded escaped
text, not executable HTML, arbitrary SQL or an editable database console.

## Activation and shutdown

`index.ts` composes the module only under the validated opt-in. Preflight verifies trusted
images, repository-owned worker bundles, resource locks and the original stored key.
`production-app.ts` installs authenticated handlers and new-choice permissions from the
same setting. Authorized project metadata tells the workspace whether to show its
Database tab and selector. Opening either starts no resource operation.

Partial startup and normal shutdown await every owned service. Missing prerequisites,
unknown cleanup and changed authority never become silent fallback or automatic rerun.
The operator's existing environment is not changed automatically.

## Checking changes

Use only the explicitly named disposable database required by
`packages/db/tests/integration/resources/app-databases.integration.test.ts`. Default tests
skip native fixtures. The opt-in worker cases exercise real roles, backups, migrations,
reader access and recovery. `WRENLY_TEST_DATABASE_COMBINED_RUNTIME=true` additionally
joins real saved-source validation and reviewed migrations to live preview HTTP and
cleanup. The fixture uses no model/provider or operator database.

`database-preview-host.integration.test.ts` verifies real preflight and empty coordinated
startup/shutdown separately. Native Docker adapter checks live under `packages/sandbox/tests`.
Public setup instructions are in the generated-app database guide in the docs app.

## Compiler errors and recovery

If a generated page fails to compile, the user should not have to recover a database
that was never started. Preparation now distinguishes an observed compiler exit from
an unknown operation. After independently confirmed cleanup, the store records
`failed-prepare-validation-artifact` and returns bounded diagnostics to the build's
existing attempts. That receipt cannot establish a prepared image or successful validation.

`validation/validation-artifact-store.ts` checks the current claim, access, exact pending
intent, absent image, absence of later effects and every cleanup receipt before recording
failure. Timeout, signal exits, lost responses, cancellation and cleanup uncertainty still
require recovery. Old interrupted operations do not acquire this evidence retrospectively.
