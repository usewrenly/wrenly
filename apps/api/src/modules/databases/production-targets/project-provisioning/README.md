# Create a project database from the saved server connection

Once the instance owner verifies the dedicated app database server, a project owner
should only need to confirm creation. This folder saves that request, generates its
three role passwords once and runs the fixed database setup steps. A project owner
does not receive the instance's management password.

The request saves the exact instance connection ID. It cannot silently move to a newly
configured server. Project access, live sessions and existing work are checked under
the same queue locks used by builds, previews and publishing.

`store.ts` records each step's intent before SQL and its acknowledgement afterwards.
The phases are roles, database, connection permissions and schema setup. `executor.ts`
orders them; `worker.ts` holds the resource execution lock and calls the fixed SQL
helpers over the private pinned TLS connection. The provider worker claims a different
journal mode, so it cannot accidentally execute a cluster request.

An **acknowledgement** means Wrenly saved evidence that this particular step finished.
If the SQL response or acknowledgement is lost, the result is uncertain. The old step
is not repeated, passwords are not replaced and the request stays blocked for inspection.
Completed steps are preserved. No code here deletes a database or resets application data.

The final `created` status means these SQL setup phases completed. It does not mean a
runtime broker was verified or an app can use the database yet. Promotion into a ready
project resource, data workflows and publishing acceptance remain separate. This worker is not started automatically and browser routes
are not enabled until those paths are connected.

Tests separate concerns: native PostgreSQL store tests cover authority, exact replay,
encrypted identities and phase records; executor tests prove ordering and no-repeat
behavior after lost responses. Native SQL and TLS socket acceptance live in the database
and sandbox packages. These are not a substitute for complete deployed-app acceptance.

## Continue after an interrupted setup

An inspection is a separate saved owner request. `recovery-store.ts` records exactly
which phase and previous acknowledgements are being inspected. `recovery-worker.ts`
uses the same resource lock as creation, then reads the original server over verified
TLS. It checks role passwords against PostgreSQL's stored password proofs, role limits,
project ownership and grants. It never returns those proofs or runs provisioning SQL.
Matching names alone are insufficient.

The result can confirm the phase, prove it absent, or require further review. The
original creation stays blocked until the owner separately confirms continuation.
Continuation consumes a recent inspection once, preserves the original actor and
secrets, and saves the current session for the remaining execution. A confirmed phase
is skipped; an absent phase can run with its original credentials. An expired report,
changed project access, uncertain inspection or changed evidence cannot authorize it.

Native tests cover every SQL phase, password/grant drift, current-session continuation,
expired reports, and lost intent or acknowledgements. These workers remain inactive
until the complete Production resource lifecycle is connected and accepted.

`resource-store.ts` transfers completed SQL creation into a pending ordinary resource
exactly once. Its server binding is separate from a Development container identity.
`resource-worker.ts` verifies the original role policy, creates an explicitly labelled
broker network, runs the actual trusted reader through a network-disabled container and
closes that socket before saving readiness. The same passwords are retained throughout.
Local and remote mutation claims are disjoint. These factories are still not registered
by startup; data workflow and deployment-host acceptance must pass before activation.
