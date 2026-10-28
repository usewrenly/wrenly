# Matching saved code to its database

A booking app revision might expect a `reservations` table that an older database
has not received yet. Opening its preview against that database would fail even
though the code and PostgreSQL each passed their own checks.

`revision-binding.ts` compares the exact successful saved source with the latest
completed migration receipt and the selected ready Development resource. It returns
only the code/database revision and schema fingerprints, never passwords or rows.
It refuses interrupted work, archived projects and mismatched migration history.

This is a compatibility check, not a reusable permission token. A caller must check
it again inside its ordered admission locks, save the binding with its execution
claim, then recheck current access/resource identity before opening a socket. It
cannot replace durable application validation or authorize a preview by itself.
Production resources are deliberately unsupported here; publishing has its own gate.

`validated-revision.ts` adds a second gate for future runtime admission. Matching table
migrations alone does not establish that the rest of the app works. This check also
requires a successful disposable validation for the exact saved application bytes,
framework, migration identity and resulting schema. Editing a page while keeping its
migrations unchanged therefore requires a new application test. The result includes
only the validation operation and source fingerprint alongside the compatibility
binding; it still grants no socket access or runtime reservation.

Laravel's existing migration review already fingerprints the entire application,
because Artisan starts its providers and configuration while migrating. A Laravel
application edit therefore also invalidates that review. Next.js migration identity
covers SQL and its journal; this additional full-source test closes the separate
application-readiness gap for that stack.

The current database revision may be newer than the validation's original revision:
an explicitly reviewed persistent migration can legitimately advance it after the
temporary test. Current ready-resource identity and applied schema are checked again
instead of treating that old revision as permission. Current access is always required.

`assertDatabaseRevisionBinding` compares all fields of a saved binding with a fresh
check. A changed sharing revision is a mismatch even when the actor still has the
same role. Owners, Editors and Viewers can read this non-secret metadata for projects
they can access; that does not grant Viewers row-query or migration permission.

The metadata acceptance fixtures cover Next.js and Laravel source, successful applied
migration history, latest-history selection, stale source/schema/resource revisions,
failed code, stopped databases, interrupted reads, sharing changes and archives. They
create synthetic migration receipts to test metadata selection; actual migrations and
Docker application validation are verified separately.

The unmounted `http/revision-binding.ts` handler accepts a bounded GET query with
exact build/resource/revision/Development selections. It rejects duplicate fields,
wrong-project output, credential fields and session changes. Checking compatibility
never starts a preview or migration. User-facing activation still waits for the
remaining module gates.

## Remembering the database with a preview

For example, a booking-app preview must not connect to a database that has moved on
to a different table structure since the selected code was validated. The internal
`admitDatabasePreview` path saves its exact code/schema evidence with the preview in
`preview_database_bindings` (migration **0033**). Its normal stateless counterpart
continues to refuse database source.

`preview-binding.ts` requires the resource identity admitted with the successful build,
the current ready Development revision, applied migrations and successful validation of
all application bytes. The revision can advance after an explicit reviewed migration;
the resource identity cannot silently change. Admission saves preview, request key and
evidence together, or rolls back all three. Replay returns the saved reservation only
for the same requested build/resource/revision. It does not reopen a connection.

`preview-claim.ts` is an explicit, uninstalled claim path. It checks the saved submitting
user, source and evidence again before reserving preparation. The ordinary preview
worker skips database-backed reservations instead of sending them to stateless Docker
preparation. `assertPreviewDatabaseBinding` rechecks a live claim, current contribution
permission, exact source, schema/evidence, lease and cleanup state before future runtime
effects. None of these reads decrypt credentials or starts a database connection.

The socket/runtime adapter, its independent cleanup and gateway lifecycle remain required
before activation. These internal metadata checks do not mean the Database UI or a live
database-backed preview is available yet.
