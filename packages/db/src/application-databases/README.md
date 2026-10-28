# Queries for a generated app's separate database

A generated booking app stores reservations in its own PostgreSQL resource. These
helpers operate on a connection supplied by a trusted isolated worker. They never
import Wrenly's configured control connection or choose an operator database themselves.
The full generated-app database product module remains disabled.

## Finding the code

| File | Responsibility |
| --- | --- |
| `driver.ts` | Pure postgres.js export for worker bundles. |
| `roles.ts` | Validate resource-bound credentials, provision roles and restrict their privileges. |
| `catalog.ts` | Read a bounded description of schema/journal structure, without app rows. |
| `migrations.ts` | Apply an explicitly reviewed migration set with exact journal-prefix checks. |
| `viewer.ts` | Return bounded base-table metadata and optional read-only row samples/pages. |

A **role** is a PostgreSQL identity with specific permissions. Runtime and reader roles
must not receive the administrator's privileges. Credential types are defined once in
`roles.ts`; viewer result types belong to their producing query in `viewer.ts`.
These remain available under the existing `@wrenly/db/app-database-*` import names.

A **migration journal** records which ordered changes were applied. The migration helper
checks that history matches the exact reviewed prefix before adding anything. Its
caller must first authorize the operation, freeze source, verify backup/rehearsal and
hold the execution fence. This helper is not a browser SQL endpoint or permission to
run arbitrary model output in the control database.

The viewer uses fixed catalog queries, escaped identifiers and supported built-in
PostgreSQL types. It excludes migration journals, bounds rows/columns/bytes and permits
read-only transactions. Tables with a supported single key can be paged; others return
a bounded sample. Those limits do not replace caller authorization or role separation.

The fixed provisioning templates are the narrow trusted DDL exception. Ordinary control
queries still use Drizzle schemas and migrations. No public viewer, resource worker or
API is enabled by importing these files.
