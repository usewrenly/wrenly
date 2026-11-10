# Work with a Production project's data

After a project database is ready, its owner should be able to create a backup from
the workspace. The password used to manage the shared server never enters the app.
The app, migration runner and data viewer each use their own restricted account.

`actions.ts` saves an explicit owner request with its current session and project
access revision. A request UUID can be read again after a lost response; it cannot
be reused for different contents. `worker.ts` owns polling, lease renewal and awaited
shutdown. Its provider-specific claims keep remote work away from the local adapter.
These factories are not registered by startup until the full lifecycle is accepted.

`backup.ts` verifies the original server and role policy, opens a migrator socket,
then captures an archive from a container with no IP network. The shared backup
executor encrypts that archive, decrypts the saved copy, restores it into a separate
disposable database and compares schema/migration history. It checks the source again
and confirms temporary cleanup before storing a verified backup record. It never
restores over the Production database or stores application rows in Wrenly's tables.

An interrupted action remains visible and blocks conflicting work. Unknown results
are not automatically retried. Current implemented actions here are creation readiness
and verified backup; migration, stop/start, viewer and publishing adapters must be
connected and tested before Production is enabled for users.

Reviewed migrations use the same saved-source, backup and rehearsal sequence as
Development. The Production adapter changes only how the exact database is reached:
a pinned private TLS connection checks authority, while a role-scoped Unix socket
carries the generated application's migration traffic. Cleanup terminates only that
project's migrator sessions. Application roles cannot write the migration journals.

Stop/start changes only a project's database connection availability. It never stops
the shared PostgreSQL server. Stopping verifies the original schema, blocks new
connections and ends sessions on that exact project database. Starting reconnects the
same database and verifies its original roles and schema before reporting ready.

The Production viewer uses the existing bounded read lease and query helper. Project
members may inspect schema; only the project owner may inspect Production rows. The
adapter opens only a reader-role socket and returns no management or migrator secrets.
These factories still require explicit host activation and joined deployment acceptance.
