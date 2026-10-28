# Keeping a database preview recoverable

A booking-app preview needs to open its application's database connection. If Wrenly
stops halfway through opening that connection, the next process must clean up the old
attempt before starting another. It must also keep the user's real reservations intact.

This folder supplies internal storage, credential checks, preparation/socket/application
controllers and a resumable cleanup sequence. Importing it starts nothing, and production
does not install it yet. The internal scheduler integration has disposable acceptance;
deliberate production installation and the user-facing workflow remain separate.

## Remember an attempt before running it

The explicit database preview claim creates an empty `preview_database_runtime` row
(migration **0034**). This is a **journal**: a record of what was attempted and what
the executor confirmed afterward. It is separate from the preview's code/schema evidence.

`runtime-store.ts` records these phases in order:

```text
prepare the image without database access
  → save the immutable image identity
  → open one runtime-role socket
  → save its exact resource/project/preview identity
  → start the application and save its runtime resources
```

An **intent** says an effect may have started. An **acknowledgement** says the trusted
adapter checked its result. A missing acknowledgement cannot be treated as failure:
the effect might have happened before Wrenly lost its reply. Pending phases and saved
image/socket identities cannot be overwritten or automatically repeated.

Every mutation requires the original preview's live claim and kernel lock, current
contribution access and the unchanged source/schema evidence. A **kernel lock** prevents
another local process from running the same preview concurrently. Losing that lock or
the short-lived database **lease** stops new work.

## Deliver only the application's role

`runtime-preparation.ts` loads the source saved with the preview and checks its complete
fingerprint against the reviewed database revision. It records the preparation target
before calling the existing Docker image builder, which installs with scripts disabled
and compiles offline without database access. Every mutation rechecks ownership and
current evidence. Only the returned immutable image ID is acknowledged. If the reply is
lost or the source changes, the preview is interrupted and its target stays available
for cleanup. It cannot silently prepare another image. `runtime-startup.ts` supplies
the acknowledged image/socket to the persistent application/ingress adapter. Production
worker installation remains separate.

`runtime-settings.ts` gives Laravel a stable Development application key, used to encrypt
its application data. It authenticates the existing private instance database key before
deriving an independent key for this project/resource. HKDF-SHA256 is the standard key
derivation method: its versioned purpose separates Development app keys from database
encryption and from Production's independently stored key. Changing code, schema or
preview does not change it; another resource or project gets a different key. Restore
the original private instance key with the resource, never create a replacement to make
startup succeed. The app key enters only process memory and the trusted bootstrap's
stdin, never source, Docker configuration, logs or the runtime journal.

Startup records intent before delivering these settings. The sandbox starts the
prepared image under a trusted PID1 guardian, runs generated code as UID1000, and keeps
the root filesystem read-only. Its application network has no external gateway; only
the separate trusted ingress reaches it. Startup confirms saved resources before
acknowledging HTTP readiness. A lost reply retains the startup target for cleanup.

`runtime-connection.ts` refuses credentials until image preparation is acknowledged.
It verifies current preview/resource identity, loads the existing private instance key,
authenticates the encrypted credential envelope and checks every role's resource name.
It returns only the runtime username/password and non-secret runtime identity, never
administrator, migration or reader credentials. The temporary key buffer is cleared.

This is a server-only executor input, not an HTTP response or model context. It does
not open a connection. The Docker adapter must still inspect exact resource labels
and deliver credentials through the trusted stdin/bootstrap path; source files, Docker
Env/Cmd and installation containers must never receive them.

`runtime-socket.ts` records socket intent before resolving the runtime role and calling
the trusted sandbox socket helper. It acknowledges the exact returned socket identity
only afterward; credentials are never returned with that identity. Failed startup marks
the preview interrupted where its lease is still held, retaining the saved effect and
reservation. It does not try opening another socket automatically.

## Clean up even after access is revoked

`cleanup-store.ts` requires the preview to be stopped, failed, expired or interrupted.
Cleanup obtains its own bounded token/lease under the original kernel lock. It does
not require the revoked contributor to regain access, and it cannot authorize app work.
Exact live replay keeps the same deadline; an expired token cannot be renewed or reused.
A replacement cleanup requires quiescence of the old executor and a new explicit token.

Four independent cleanup receipts are required before releasing preview capacity:

- Application, ingress and their isolated resources are gone.
- The preview's dedicated socket is gone.
- Its scoped runtime sessions are confirmed stopped.
- Its preparation workspace and retained image are gone.

These steps are ordered, not just a checklist. For example, confirming that no database
sessions remain while the app can still reconnect would give false assurance. Storage
therefore checks the preceding exact-target receipts before recording each removal and
again before accepting its result. A receipt for another preview does not count, and a
completed step cannot be recorded a second time. An uncertain pending step remains
available to explicit recovery rather than being skipped.

Cleanup records its own intent before removal and acknowledges only that removal.
An unknown original execution effect stays recorded even after cleanup completes.
Uncertain cleanup keeps the capacity reservation. Runtime and cleanup methods never
drop the persistent Development database, alter its schema or change its revision.

## What has been verified

Disposable PostgreSQL acceptance exercises real instance-key encryption and local
kernel locks for Next.js and Laravel. It verifies role-only delivery, preparation
gating, wrong role/resource binding, effect ordering, immutable acknowledgements,
revoked/expired cleanup, lost cleanup acknowledgements, replacement ownership and
unknown-effect preservation. Docker identities in these journal tests are synthetic;
they do not establish complete live container/socket/session integration.

Separate real Docker cleanup checks verify that scoped socket removal rechecks its
claim before both container and volume deletion. Lease loss between them preserves
the remaining volume for recovery. Image cleanup also refuses live references and
preserves foreign resources. Native database acceptance separately verifies scoped
reader, migrator and runtime-session termination. Connecting the complete live
application/ingress path remains a separate acceptance gate.

`runtime-application.ts` now connects the application cleanup receipt to the trusted
preview remover. It passes the original preview/build/claim identity and an independent
cleanup check before every Docker deletion and workspace removal. Lost cleanup authority
halts further removal and retains the pending receipt. It keeps the kernel lock for
the following socket/session/artifact steps; it neither starts an app nor enables the worker.

The guarded `packages/sandbox/tests/preview-cleanup.integration.test.ts` fixture creates
only disposable labelled Docker resources, using an already-cached trusted PostgreSQL
image without starting a container. It proves an initial lost claim removes nothing,
loss after container deletion preserves its network/volume, and explicit recovery
preserves a foreign claim's volume. Run it with `WRENLY_TEST_PREVIEW_CLEANUP=true`;
never substitute an existing preview identity for the generated fixture identities.

`runtime-sessions.ts` confirms that the stopped preview's runtime-role database sessions
are gone, after application and socket removal are acknowledged. It uses the separate
cleanup claim, so revoked project access cannot strand cleanup. The original resource
revision, private runtime identity and encrypted role bundle are checked again; only
the trusted administrator helper receives that bundle. The helper terminates the exact
resource's runtime role and confirms no matching sessions remain. A failed or uncertain
result keeps its intent and capacity reservation. It never terminates another role or
starts another preview. The full live startup and gateway path is still uninstalled.

`runtime-artifact.ts` closes the last cleanup category. After app/socket/session
receipts it removes only the preview UUID's preparation workspace and retained runtime
image, using the shared `artifacts/runtime-artifact-cleanup.ts` sandbox adapter. That
adapter is also used by validation and recovery: its location describes the resource
it owns rather than one caller. Unknown preparation still has a UUID for exact discovery.
Live image references, lost cleanup authority or uncertain removal retain the artifact
intent and capacity; cleanup never removes the persistent Development database or marks
the original preparation successful. Releasing capacity still requires the separate
finish operation after all four adapter results are acknowledged.

## Resume the cleanup sequence

`runtime-cleanup.ts` connects those four controllers. For example, if socket removal
loses its reply after application removal was confirmed, explicit recovery resumes at
the socket. It does not stop the application again or jump ahead to image removal.
Only an exact ordered set of saved confirmations can make a step count as complete.
Foreign targets, duplicate confirmations and a mismatched pending target block work.

The caller must already hold the cleanup claim and kernel lock. It supplies a separate
cleanup shutdown signal: the original application's cancellation must not prevent
resource cleanup. The sequence renews the existing lease between steps without extending
its fixed deadline. A stopped caller, lost lock or uncertain removal ends the sequence;
there is no automatic retry or replacement claim. A later explicit recovery reads the
saved progress again. Capacity is released only by the existing transaction that
verifies all four confirmations. The persistent application database is retained.

Disposable PostgreSQL acceptance runs the sequence for both frameworks, loses socket
and artifact replies, resumes without repeating confirmed removals, and checks abort,
lost-lock and malformed-confirmation refusal. Its Docker adapters are test doubles;
this proves orchestration/storage behavior, not the complete live runtime integration.

## Check access again when traffic arrives

`bindings/preview-readiness.ts` is called by preview grant creation, grant exchange and
each gateway session check. For database declarations it requires all three exact
runtime confirmations, matching image/socket identity and current source/schema access.
A saved ready label alone is insufficient. Removing the declaration from preview source
does not turn its original database build into a stateless app. Ordinary previews keep
their existing path and do not require database-module tables.

The viewer's account/session/project permissions are still checked separately. A Viewer
can read a ready preview but does not gain contribution permissions or the runtime role.
The original executor must still have authority to keep the database app running.
Disposable acceptance uses actual Viewer grants/sessions and verifies denial at all
three entry points when a runtime confirmation disappears, as well as session revocation.
This authorization check starts no work and does not enable database previews.

## Connect the scheduler without starting it on import

`runtime-worker.ts` supplies dependencies to the existing bounded preview scheduler.
It claims explicit database reservations, prepares an image, opens the runtime socket,
starts the app/ingress and monitors current authority plus container health. The gateway
map exposes the result only after ready is saved. Cleanup removes it from that map
before any external removal. Generated logs and credentials do not enter activity.

The host supplies real kernel-lock acquisition/check/release and a way to prove an old
executor is no longer running. Recovery waits for that proof outside database locks.
`runtime-recovery.ts` then locks queues, account, project, resource and preview in order,
revokes stale readiness and removes viewer grants before starting independent cleanup.
It does not require a suspended user to become active again. Ordinary preview recovery
skips database declarations so it cannot bypass the four cleanup receipts.

An existing cleanup owner or uncertain cleanup is blocked on later scheduler polls,
including after constructing another worker. It requires explicit recovery; a poll does
not mint replacement authority or rerun an unknown removal. Confirmed cleanup alone
releases capacity. The original unknown startup stays recorded independently.

Internal runtime transactions wait for queue locks in the same fixed order, then check
leases again before writing. This avoids a scheduling poll briefly holding a queue and
causing an unrelated preparation to fail. HTTP admission keeps its existing fail-fast
behavior. No database lock is held while Docker runs.

Disposable scheduler acceptance covers stop, shutdown, contributor revocation, unknown
startup, failed cleanup, explicit cleanup recovery and an old executor. It uses real
PostgreSQL and kernel locks with synthetic Docker callbacks. The native Docker adapters
have separate live acceptance; these checks do not claim complete generated-project or
Production publishing acceptance. The tests can be focused with
`WRENLY_TEST_DATABASE_PREVIEW_WORKER_ONLY=true` together with the guarded disposable
`WRENLY_TEST_APP_DATABASE_URL`, selecting the `database preview worker` test cases.

`production-preview-worker.ts` is the explicit host factory. It requires enabled local
preview configuration, Linux host execution, current persistence, cached trusted images,
an actual kernel-lock handshake and the same Docker host-isolation probes as ordinary
previews. It derives ingress capabilities from the instance secret and original claim.
Stopping waits for the scheduler and releases quiescent kernel locks even when durable
cleanup needs later recovery. It does not clear that recovery reservation.

The opt-in `database-preview-host.integration.test.ts` uses an empty local
`wrenly_database_preview_host_test` database. Set both
`WRENLY_TEST_DATABASE_PREVIEW_HOST=true` and `WRENLY_TEST_DATABASE_PREVIEW_HOST_URL` to
that disposable database to run actual host startup/shutdown checks. It refuses an
existing resource or preview and creates no application resource. This is host-factory
acceptance, not full generated-project acceptance or installation by `index.ts`.


The opt-in `production-module.ts` lifecycle now joins this worker with resource execution.
API startup supplies the trusted ingress, the gateway reads both stateless/database runtime
maps, and shutdown awaits both paths. The same validated Development flag controls HTTP
admission and authenticated feature metadata. This does not add Production database publishing.
