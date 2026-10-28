# Internal generated-app database helpers

Imagine a generated booking app needs to save reservations. Its data must live in a
separate application database, away from Wrenly's own accounts, projects and credentials.
These helpers prepare that separate database and tightly scoped connections to it.

**The generated-app database product module is not enabled.** These are internal building
blocks, not an available database screen or a complete database-backed app workflow.
Importing a helper does not start a worker or provision storage.

The ordinary build runner also refuses source declaring a database in
`wrenly.app.json`, before installing packages or starting containers. For example,
compiling a booking app without ever saving a reservation does not prove its database
works. Database-backed validation must instead create an isolated test database,
apply the saved migrations and exercise the app there. That path is still unfinished;
the runner must not substitute real Development or Production data to pass a build.

## How access is separated

A generated client container has no IP network access. It receives a **Unix socket**,
a connection endpoint mounted as a local file, for one authenticated database role.
A role defines which operations PostgreSQL permits. An app role can read/write app data;
a viewer role can read it; neither is a database administrator.

Docker resource names are not proof of ownership. Helpers compare saved project,
environment, resource IDs, labels and image/network/volume identities before use.
Development and Production are separate scopes. Unknown existing resources require
review; the helpers do not silently adopt them or replace their passwords.

Disposable cleanup checks the environment and exact purpose as well as the project
and resource. A database container cannot pass with an initializer's label, for
example. All inspected resources must match before removal starts. Containers and
networks are removed by their inspected IDs; leftover socket/helper attachments block
cleanup until their own scoped cleanup has completed.

The caller must hold an execution **fence**: proof that its lease and kernel lock are
still valid. Before a change, it saves durable **intent** describing the operation.
After confirmation, it saves an **acknowledgement**. If a process dies between those
steps, recovery inspects the result instead of assuming the operation never happened.
These callbacks are required inputs; this library does not own the API's job queue.

## Finding the code

| File | Responsibility |
| --- | --- |
| `application-runtime/` | Process-local framework connection settings and the trusted disposable-app startup guardian; not wired to product execution yet. |
| `laravel-migrations.ts` | Prepare frozen Laravel source and run offline Artisan plus independent native-journal verification. |
| `database-manifest.ts` | Read declarations and freeze migration file identities without executing source. |
| `database-resource-policy.ts` | Derive names/labels and verify exact ownership and socket policy. |
| `database-toolchain.ts` | Check trusted local images and host support without provisioning anything. |
| `database-runtime.ts` | Create, inspect and stop/start owned persistent resources under caller fences. |
| `database-socket.ts` | Expose one authenticated role through a Unix-only endpoint. |
| `database-administrator.ts` | Run trusted role/schema administration bundles, never browser/model commands. |
| `database-socket-worker.ts` | Run trusted query or reviewed migration bundles through the selected socket. |
| `database-backup-runtime.ts` | Capture bounded archives or restore into disposable resources. |

Credentials go through child-process input, not Docker command arguments/environment
or host files. Archive encryption and durable storage belong to the caller, not the
capture adapter. Restoring a backup and replaying a migration are separate operations;
a cleanup acknowledgement must not claim that an uncertain migration succeeded.

The narrow provisioning exception uses trusted Drizzle templates in `packages/db`.
It does not permit a public SQL console, arbitrary model SQL or manual changes to
Wrenly's control schema. Laravel migrations use the internal Artisan runner inside Docker; this does not enable
the database product module. Laravel review identities already include every saved source file, because Artisan
loads application bootstrap/providers as well as migration files. Editing any of those
files requires a new review. The listed migration hashes remain available separately.
Next.js keeps its existing SQL/journal identity.

## Verification and limits

Unit tests live in `packages/sandbox/tests/unit/database-*.test.ts`. The opt-in
`database-runtime.integration.test.ts` exercises real PostgreSQL roles, persistence,
backup/restore and socket clients with disposable UUID-scoped Docker resources.
It needs the repository-owned `wrenly/postgres-runtime:17` and
`wrenly/database-socket:1` images and a local Docker socket. It must never target an
operator database. Passing internal tests does not enable the unfinished product module.

### Laravel migration bridge (not activated)

`images/laravel/migrate.php` is a trusted entry point copied into the operator-owned
Laravel image. It boots Artisan and runs fixed `migrate --force --no-interaction`
arguments for reviewed paths only, using one migrator role over the local Unix socket.
Credentials arrive on stdin and are set only in that short-lived process; they are
not Docker configuration or saved application files. Console errors are redacted.
The per-run application key is temporary, not a deployed application's persistent key.

`laravel-migrations.ts` rechecks the whole-source identity and prepares an isolated
application artifact without database credentials or a database socket. It then runs
Artisan offline through the scoped socket. A trusted PID1 watchdog bounds PHP lifetime
even if the API disappears; generated code runs as a separate unprivileged user.
A second trusted Bun helper checks Laravel's actual migration journal without loading
application PHP. Generated output alone is never migration confirmation.

The adapter removes its prepared image after helper cleanup. Callers retain verified
backup/rehearsal, schema comparison, durable review and uncertain-effect recovery.
For fresh application validation, `runPreparedLaravelDatabaseMigrations` instead reuses
an operation-bound image prepared before the database starts. It rechecks the whole-source
review and leaves the image with its caller for the subsequent HTTP check and cleanup.
This avoids running a full image build alongside the database's CPU/memory allocation.
The API's internal migration executor selects the adapter from the saved revision's
framework; browser input cannot choose an image or command. Rehearsal creates/restores
an entirely separate database and compares its native schema before persistent work.

Toolchain images built before the bridge/watchdog was added must be rebuilt from
`images/laravel`. The module's HTTP/UI, application bindings, Production workflow and
complete recovery/activation acceptance remain unfinished. Do not start the internal
worker manually to treat these helpers as a released database service.
