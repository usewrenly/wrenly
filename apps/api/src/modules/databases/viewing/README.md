# Reading application data safely

Imagine a teammate opens the booking app's reservations table. An Editor may inspect
Development reservations; a Viewer may inspect column names but not reservations.
Production rows are reserved for the project owner. Instance administration alone
does not grant access to someone else's project.

These are internal viewer services, not an enabled Database tab or mounted endpoint.
The local Development reader path has real PostgreSQL/Docker acceptance. Production
connections and the rest of the application-database lifecycle remain unfinished.

## Follow a read

1. `view-contract.ts` validates an explicit database ID, environment, revision and table.
   Requests cannot contain SQL, credentials or an arbitrary connection address.
2. `view-authority.ts` checks current project permission and the exact ready resource.
   It selects only identity/status fields; it never loads credentials.
3. `view-service.ts` captures that authority, runs the read adapter, validates its bounded
   result and checks authority again. Permission changes discard the result, including
   a revoke/restore that leaves the person with the same role.
4. `view-leases.ts` records a short-lived running read operation. The **lease** is a
   claim with an expiry time. It prevents database changes from overlapping the read;
   rows themselves are never saved in Wrenly's control database.
5. `view-runtime.ts` holds the resource's local execution lock and renews the lease.
   It loads only the reader credential, opens a scoped Unix socket, runs the trusted
   read helper with IP networking blocked and closes the socket before finishing.
6. `view-http.ts` checks the browser session before and after the operation and returns
   private, uncached JSON. The factory does not register an API route on import.

Selection and response validation live in the pure shared
`@wrenly/db/app-database-viewer-contract` subpath. `view-contract.ts` reuses that selection
schema and adds server permission rules; the web viewer uses the same validators.
The optional Hono registration is `/api/projects/:id/databases` for authorized status
and `/api/projects/:id/databases/view` for explicit inspection. Production supplies
neither handler yet, so those routes remain unavailable in ordinary installations.

The **access revision** is an identifier that changes when project access changes.
The resource revision identifies the reviewed database state. Both must still match
before any rows leave the server. A failed read never falls back to old cached rows.

## Why cleanup has its own record

A completed query does not prove that its connection was closed. Socket closure has
its own saved intent and acknowledgement. The read claim cannot finish successfully
until closure is confirmed. Cleanup uses the lease and kernel lock independently of
the browser's cancellation signal; cancelled reads still need their sockets closed.

If the API disappears before any external effect, the owner can explicitly recover
that effect-free read through the existing recovery path. For an abandoned socket/helper,
`view-recovery.ts` records a separate owner-reviewed cleanup action. It holds the resource
lock, removes only the old read's exactly labelled helpers and verifies that the saved
database is still ready. Foreign same-name resources cause refusal, not adoption/deletion.

The original read is recorded as failed and its unknown effect is preserved. Recovery
never runs the query again or returns old rows. An exact action replay reads its saved
acknowledgement; another cleanup attempt requires a new explicit review. This path rejects
migration/mutation operations and cannot clear uncertain SQL changes. Those still require
their separate recovery workflow.

## Shared contracts and verification

Pure result types and limits live in
`packages/db/src/application-databases/viewer-contract.ts`. The trusted Drizzle reader
and HTTP validation use those same bounds. Tables and cell values remain plain data.

Unit tests cover role/environment permissions, malformed requests, permission changes,
schema-only responses, cancellation, session expiry and redaction. The guarded
`packages/db/tests/integration/resources/app-databases.integration.test.ts` additionally
checks real authority/lease behavior and both framework worker scenarios with real
Development rows and schema-only Viewer results. Use its disposable database guard;
never point acceptance at an operator database.
