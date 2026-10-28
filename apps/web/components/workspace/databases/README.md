# Seeing a project's database status

A booking app may have a Development database for testing and a separate Production
database for real reservations. This screen keeps them distinct and shows only what
the API has confirmed. It never creates resources just because someone opens a tab.

`database-overview.tsx` is the resource/status presentation component. The parent
provides a project-bound result and explicit callbacks for setup, management and viewer
navigation. It validates the existing shared browser-safe status contract; it does not
define a second API shape or import the control database client. Invalid or stale
responses show a safe reload state instead of the last project's details.

Owner controls follow server capabilities. Viewers can inspect schema; Development
rows require the corresponding capability. Production opens schema first so that later
row inspection can retain its separate owner confirmation. Backend authorization is
still required for every action; hiding a button does not grant or revoke access.

`database-workspace.tsx` connects authenticated resource status to the overview and
viewer. `database-viewer.tsx` starts with a table list and explicitly selected schema or
rows. Production starts with schema and asks the owner before opening rows. Samples,
shortened values, NULL and empty text are distinguished; cell text never becomes HTML.

The browser requests live in `lib/databases/requests.ts`. They reuse the same pure
selection/result schemas as the API, bound body size and duration, and reject a response
that does not match its requested table/mode. `use-database-view.ts` keeps rows out of
the shared query cache and aborts old reads when selection changes or the viewer closes.
Status failure/refresh unmounts the viewer rather than retaining previously authorized
rows. The parent keys it by account/project/resource/revision/current capabilities. Status queries also include the signed-in account, so changing accounts cannot reuse another account’s confirmed status.

The API installs status/view/action handlers only with its Development opt-in. Authorized
project metadata enables the workspace navigation; disabled instances expose neither.
`database-owner-controls.tsx` offers confirmed Development creation, start/stop and
verified-backup requests. A receipt means the request was accepted, not that execution
finished. It saves the request identity in account/project-scoped browser session
storage before sending. Lost replies offer receipt lookup or an identical retry;
closing the dialog preserves that record. Storage failure blocks new commands.
`database-migration-review.tsx` loads the explicitly selected saved revision, shows
its migration text and requires a verified-backup choice and source acknowledgement.
Laravel also asks the owner to review the full source because Artisan boots application
code. No implicit latest revision or automatically selected backup is used.
`database-recovery-review.tsx` displays server-reviewed inspection/cleanup choices;
confirmation never repeats the interrupted action or overrides backend checks.
Production database provisioning and publishing remain separate unavailable workflows. No example rows are shown in real projects.

The guarded browser fixture (`WRENLY_TEST_DATABASE_BROWSER=true`) uses real components
and transport with controlled responses. It does not query an operator database. Unit
checks also cover stale/private payloads, role controls, malformed views and body limits.


`database-build-selector.tsx` is the explicit composer choice. It starts with No database,
loads only authenticated actor/project-scoped metadata and offers a ready Development
resource with no unresolved work. It never chooses automatically or clears stale choices
silently. The workspace keeps the choice scoped to the current project/account and sends
only the shared resource/revision value. The trusted `databaseEnabled` composition prop
defaults false; authenticated project feature metadata enables it only on opted-in instances.

Pending conversation requests retain that value through restoration. Safe turn summaries
also return it so retry uses the original choice, even if the current composer differs.
The browser refuses malformed or secret-bearing choices rather than dropping them.
