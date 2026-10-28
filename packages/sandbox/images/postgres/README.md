# Managed PostgreSQL toolchain

From the repository root:

```bash
docker build -t wrenly/postgres-runtime:17 packages/sandbox/images/postgres
docker build -t wrenly/database-socket:1 packages/sandbox/images/database-socket
```

The first image targets PostgreSQL 17 with its verified Alpine user ID. Wrenly
resolves the installed image to an immutable ID for each new database and retains
that identity. Reopening a database never pulls a newer tag or initializes missing
data. The second image provides PgBouncer and a trusted bounded-input launcher.
Image acquisition/package installation is an operator toolchain step, not execution
of generated source. Air-gapped installations must prepare both images beforehand.

The API starts these adapters only with its explicit Development database opt-in. They
require Linux, the local Docker socket and Docker CLI. The CLI always uses the
explicit local socket; environment-based remote Docker destinations are not used.
Initialization and socket configuration arrive on stdin, outside Docker Env/Cmd
and host files. The short-lived initializer has narrowly added ownership/user-switch
capabilities; the long-lived database and broker drop all capabilities and have
read-only roots, bounded memory/CPU/processes and no published ports.

PostgreSQL data lives in an explicitly named, ownership-labelled volume. Runtime
containers receive only an authenticated socket volume, never that data volume.
Socket configuration/authentication files live in a private temporary filesystem.
The directory permits traversal by unprivileged apps; the socket still requires the
selected role's password. One socket maps to one database and non-admin role.

Every external mutation requires caller-provided durable intent/acknowledgement and
lease/kernel-lock checks. These callbacks are not optional. Partial provisioning
preserves data for explicit reconciliation. No general-purpose deletion/reset API
is provided; fixture cleanup is confined to randomly identified test resources.
Role provisioning is implemented by a trusted helper bundled by the API build;
its pure database exports never load the control database client. An internal
production-worker factory is installed only by the opt-in database host lifecycle. Explicit
resource recovery, cross-module fences, migrations/backups, viewer and application
bindings remain parts of the approved database module.

Controlled acceptance:

```bash
WRENLY_TEST_APP_DATABASE_RUNTIME=true bun --no-env-file test packages/sandbox/tests/database-runtime.integration.test.ts
```

The socket client check also requires the existing
`wrenly/laravel-runtime:13-php8.4` toolchain. Tests create disposable resources,
exercise Postgres.js and PDO prepared transactions from network-disabled containers,
and remove their labelled containers, networks and volumes. They do not certify
generated applications, the bounded viewer, remote providers or publishing.
