# Reading a generated app's database

When someone opens a booking app's database, the browser first asks which resources it
may inspect. Opening a table then names the exact database revision and whether schema
or rows are requested. These helpers send those requests through Wrenly's authenticated
API proxy; the browser never connects to PostgreSQL or receives database credentials.

`requests.ts` loads bounded, uncached status and viewer results. Both use pure shared
contracts from `@wrenly/db/app-database-*`; importing them does not load a control client.
The API uses those same validators. Responses from another project/table, unexpected
private fields, rows in a schema-only result, excessive bodies and cancelled reads are
discarded. Provider/database error text never becomes a browser error message.

`commands.ts` sends explicit owner actions and checks saved acknowledgements. An
acknowledgement is a receipt for admission into the work queue, not a completed backup
or running database. Replies have a small size limit and deadline; raw service errors
stay private. A lost or malformed reply is unconfirmed, so a retry keeps the identical
request ID and contents. A missing receipt does not prove an earlier write cannot finish.

`pending-action.ts` saves only non-secret operation identity and revision metadata in
browser session storage, separately for each account/project. Save succeeds before the
first POST. Restoring a record never sends a command automatically; clearing checks the
whole saved record so an older response cannot erase a replacement request.

No SQL console or automatic resource operation is implemented here. API permissions
and cleanup remain mandatory even if the UI hides a button. Production route
installation is a separate explicit step.

Review reads also bind exact resource/build or interrupted-operation identities. The
browser rejects a different identity and renders source as text, never generated HTML.
Recovery actions use their separate HTTP boundary while retaining the same persisted
request and receipt rules. The selected saved build must be supplied by the workspace;
review never substitutes the latest revision when none was selected.
