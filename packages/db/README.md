# Saving Wrenly's state

You send “Build a booking app,” then refresh the browser. Wrenly can resume showing the
same build because PostgreSQL holds the project, messages, job status and progress.
This package describes those saved records and provides the API's database connection.

That is Wrenly's **control database**. It is separate from a generated booking app's
own reservations database. Mixing them would give application code access to Wrenly's
accounts and credentials, so internal application-database helpers use separate
connections and pure package entrypoints.

## Choose the right import

```ts
// API code that needs the configured control-database pool:
import { db, projects } from '@wrenly/db'

// Tables and inferred types, without loading a configured pool:
import { projects } from '@wrenly/db/schema'
```

A **schema** describes tables, columns, relationships and types. Drizzle derives row
types from those definitions; do not make a second handwritten copy of the same stored
record. A **connection pool** reuses a bounded number of database connections rather
than opening a new connection for every request. Importing the configured entrypoint
validates `WRENLY_DATABASE_URL`; postgres.js opens actual connections when needed.

## Finding the code

| Location | Responsibility |
| --- | --- |
| `src/schema/` | Identity, projects, execution, resources and configuration table groups. |
| `src/connections/client.ts` | Shared control pool for ordinary API work. |
| `src/connections/recovery-client.ts` | Separate short-lived recovery pool with stricter server deadlines. |
| `src/connections/database-url.ts` | Shared password-safe URL validation, with no network activity. |
| `src/application-databases/` | Pure internal generated-app database adapters; no control-client import. |
| `migrations/` | Ordered schema changes and Drizzle's recorded metadata. |
| `drizzle.config.ts` | CLI configuration for generating/applying migrations. |
| `tests/` | Disposable PostgreSQL acceptance and focused unit fixtures. |

Schema and integration folders use the same feature vocabulary:

```text
src/schema/                 tests/integration/
  identity/                   identity/
  projects/                   projects/
  execution/                  execution/
  resources/                  resources/
  configuration/              configuration/
                              connections/
```

Choose the feature first, then its table or acceptance scenario. The central schema
export remains the public entrypoint; feature folders need no extra barrel files.

A **transaction** saves related changes together or rolls them back together. Domain
rules such as build admission and project sharing live in API modules; they use these
tables inside transactions. The database package does not decide who may share a
project, start a build or become an instance owner.

## Changing tables safely

A **migration** is a saved, ordered change to the database structure. Existing installs
apply the same history as new installs. Keep reviewed migration files unchanged once
used; add a new migration for a later change.

1. Update the relevant Drizzle table definition.
2. From `packages/db`, run `bun run db:generate` and review the generated SQL/metadata.
   Use `bun run db:check` to check the saved migration history for conflicts; it does
   not compare an operator database or prove all upgrade behavior.
3. Apply it to a disposable database and check both fresh install and upgrade behavior.
4. Apply the reviewed chain using `bun run db:migrate` when operating an instance.

There is no `db:push` shortcut: schema changes must remain reviewable and replayable.
Migration tooling reads the repository root `.env`, with explicit shell variables taking
precedence. API startup supplies its own environment. Both require a PostgreSQL
`WRENLY_DATABASE_URL`, and neither prints it in validation errors. Never run test scripts
against your working instance database.

## Internal generated-app helpers

The `app-database-*` subpaths deliberately avoid the configured control client. They
serve trusted isolated workers using separately supplied connections. Their narrow role/
database provisioning exception uses fixed Drizzle templates, not browser/model SQL.
The generated-app database product module remains disabled; these helpers do not provide
a complete database viewer, migration or publishing workflow on their own.

`app-database-resource-contract` is a pure exception to the worker-oriented paths:
it defines the safe resource/status response shared by API and UI, without opening a
database connection or loading environment variables. It accepts only bounded public
metadata and rejects unknown fields, duplicate identities and inconsistent capabilities.
`app-database-action-contract` similarly shares the action/revision/confirmation and
saved-receipt schemas with API/UI. Credential generation remains server-side in the API;
importing a public contract never generates secrets or connects to PostgreSQL.

## Checking the connection boundary

```bash
bun test packages/db/tests/unit/database-url.test.ts
bun run --cwd packages/db check-types
```

`tests/integration/connections/control-connections.integration.test.ts` additionally requires an explicit local
`WRENLY_TEST_FOUNDATION_DATABASE_URL` ending in `/wrenly_foundation_test`, with repository
migrations already applied. It checks migration history and recovery pool behavior.
Other integration suites have their own disposable database guards; do not replace
those with a fallback to `WRENLY_DATABASE_URL`.

The pure `@wrenly/db/app-database-binding-contract` subpath describes an exact
Development code/database selection and its non-secret revision snapshot. It does
not import the control connection or grant runtime credentials. For example, the
API can compare a booking-app revision with its applied migration identity before
admitting a future preview. Runtime reservation and application validation remain
separate requirements; a compatible snapshot is not proof of a working app.
