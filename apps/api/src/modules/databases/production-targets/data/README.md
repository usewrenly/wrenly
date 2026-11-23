# Work with a Production project's data

After a project database is ready, its owner should be able to create a backup from
the workspace. The password used to manage the shared server never enters the app.
The app, migration runner and data viewer each use their own restricted account.

`actions.ts` saves an explicit owner request with its current session and project
access revision. A request UUID can be read again after a lost response; it cannot
be reused for different contents. `worker.ts` owns polling, lease renewal and awaited
shutdown. Its provider-specific claims keep remote work away from the local adapter.
The explicitly enabled Production module registers these factories at startup.
The feature is experimental: successful activation does not establish complete
remote publishing or recovery acceptance.

`backup.ts` verifies the original server and role policy, opens a migrator socket,
then captures an archive from a container with no IP network. The shared backup
executor encrypts that archive, decrypts the saved copy, restores it into a separate
disposable database and compares schema/migration history. It checks the source again
and confirms temporary cleanup before storing a verified backup record. It never
restores over the Production database or stores application rows in Wrenly's tables.

An interrupted action remains visible and blocks conflicting work. Unknown results
are not automatically retried. Creation, verified backup, reviewed migration, per-project stop/start and the
read-only viewer are connected. Publishing has a separate ordered executor.
`operation-recovery.ts` resolves recognized interrupted backup/migration cleanup
through a separate owner request. For example, a lost migration reply may leave a
client behind after its SQL completed. Recovery first removes only the original
operation's owned clients and disposable resources, then checks the original cluster,
roles, schema and native migration journal. It never sends the SQL again.

A migration becomes successful only when the independently observed result matches
its frozen, verified rehearsal. A partial or different result stays blocked. Backup
cleanup leaves the original backup failed: it cannot invent a verified archive.
The original uncertain effect remains in history alongside the separate cleanup
acknowledgement and recovery outcome. `operation-recovery-policy.ts` admits only
known fixed effect identities; foreign resources and missing evidence are refused.
Exact request replay returns the saved result without another cleanup.

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
These factories require explicit Production activation. Native tests cover actual
Next.js and Laravel database reads/writes and explicit app restart; real Coolify
routing and automatic host/broker reboot recovery remain separate acceptance gates.

HTTP composition is explicit: `http.ts` supplies Production-only action admission
and the control-cluster identity needed by the viewer and stop/start recovery.
Development keeps its local adapter. The server advertises Production controls only
when that complete resource composition was supplied; a browser cannot enable them.
