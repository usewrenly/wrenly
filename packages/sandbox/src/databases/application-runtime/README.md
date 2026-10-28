# Starting an app with a private database connection

Imagine a generated booking app saving a reservation. It needs its own restricted
database account, but its password must not be saved in the generated source or Docker's
inspectable configuration. These internal helpers prepare the app's connection settings
and start it with those settings only in process memory.

Validation and preview adapters use these helpers internally; the user-facing database
module is **not activated**. These helpers do not create a database, verify a saved
binding, run migrations or prove that a whole generated app works. The caller owns
those checks before delivering any runtime settings.

## Finding the code

- `environment.ts` accepts only the runtime account belonging to the exact resource.
  It produces standard `PGHOST`/`PGPORT`/`PGUSER` settings for Next.js/Postgres.js, or
  Laravel's `DB_CONNECTION`/`DB_HOST` settings. Both select the fixed local Unix socket.
  `postgres()` reads those PostgreSQL variables. Do not replace them with a URL carrying
  a `host` query parameter: Postgres.js does not use that parameter to select a socket.
- `bootstrap.ts` runs as **PID1**, the first process inside the container. It receives
  a small, strictly checked JSON request on stdin, creates the settings in memory and
  starts the framework's fixed server command as user1000. The guardian stays a separate
  privileged user, so generated code cannot kill the process enforcing its deadline.
  Its separate preview entrypoint requires the caller's stable Laravel key and bounds
  the app to at most one hour. Disposable validation keeps its temporary key and shorter
  lifetime. Both reject malformed settings and suppress generated stdout/stderr.
- `runner.ts` is the internal prepared-image HTTP adapter. It checks operation-bound
  image provenance and socket ownership, records intent through the caller, delivers
  credentials on stdin and removes its helper before returning HTTP readiness.
  It accepts only a disposable resource whose ID is the operation ID, distinct from
  the source resource. It never opens a socket or creates a database by itself.

The JSON request has `framework`, `resourceId`, `role: {user, password}` and
`lifetimeMs`. No command, URL, image, path or arbitrary environment map is accepted.
The API build emits `database-application-worker.js`; its loader reads only this trusted
entrypoint. Importing the exported bootstrap function does not run it.

The guardian reads at most8KiB within5seconds, then starts the child under the remaining
requested lifetime (at most5minutes). It probes only `127.0.0.1:3000` and emits a fixed
readiness marker once. Child stdout/stderr are suppressed because application logs can
contain credentials. Readiness means HTTP responded; it does not certify database CRUD,
schema compatibility, persistent migration approval or overall validation success.

## What the caller must enforce

Use the trusted prepared image and verify its saved identity. Mount the scoped runtime
socket and trusted bootstrap read-only. Keep IP networking disabled, the filesystem
read-only, and provide bounded writable temporary directories where the framework needs
them. Run PID1 as root with only `SETUID`/`SETGID` capabilities and no new privileges;
generated code runs as user1000. Never pass the request as Docker Env/Cmd or a host file.

The caller still owns authorization, durable intent, leases, ownership checks, cancellation,
resource cleanup and the **combined** CPU/memory/deadline budget across the database,
socket and app containers. A per-container limit alone does not enforce that total.
The wrapper's Laravel application key is temporary and is suitable only for disposable
validation, not a persistent preview or a published application.
Its fixed startup step creates Laravel's required cache, session, view and log directories
as user1000: empty writable mounts hide the directories that were baked into the image.

The runner reserves512MiB,0.5CPU and64processes for the app container, with swap capped
at the same memory limit. Prepare the image before starting a disposable database;
compiling alongside the database would otherwise add their limits together. The caller
still owns the overall job deadline and limits across every stage.

Its `cleanup` callbacks are separate from the execution fence: the caller must save a
cleanup intent and acknowledgement under an independent lease/kernel check, even when
the user cancels the HTTP check. A failed startup retains its unresolved execution
intent after cleanup. A failed cleanup acknowledgement also prevents a successful
return, even if Docker already removed the container. These callbacks are not wired to
a product validation claim/store yet; this adapter alone does not activate a workflow.

## Verification

Unit tests check exact account selection and fixed settings. The opt-in
`database-runtime.integration.test.ts` proves Postgres.js and PHP PDO can write through
those settings and rejects a wrong password. The separate
`database-application-bootstrap.integration.test.ts` checks both fixed server commands,
process-local credential delivery, suppressed secret output, non-root execution,
readiness, invalid input and independent termination in disposable Docker containers.
The Next executable and PHP page there are tiny fixtures, not full framework acceptance.

The real socket acceptance also joins these two parts: a Postgres.js fixture and a PHP
HTTP page each create, read, update and delete test rows through the runtime account,
then reach HTTP readiness under the guardian. The database is disposable and client
containers have no IP network. This proves the connection/startup path together; it
still does not validate a complete saved Next.js or Laravel application and its migrations.
Both HTTP fixtures are also started with an incorrect runtime password. They must
terminate without the readiness marker, and the final persisted row count must remain
unchanged. A server process starting is not enough when its database access fails.
Prepared-image adapter checks use a separately owned fixture image, verify scope
refusal and confirmed container removal, and simulate a failed cleanup save to ensure
the execution is not falsely acknowledged. That small image is not a full framework app.
