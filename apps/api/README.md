# Wrenly API

The API coordinates work for the builder. For example, when someone asks to change a
booking app, the browser sends the request here. The API checks their access, saves the
request, calls the framework's MCP tools and validates the returned code in Docker.
MCP (Model Context Protocol) is how the API calls framework tools without importing
those servers' implementation. Hono handles HTTP; Bun runs the server and workers.

## Start a development instance

Follow [Install Wrenly](../docs/content/docs/guides/installation.mdx) from the repository
root first. It covers private configuration, PostgreSQL, migrations and the web app.
Apply all checked-in migrations before starting an updated API; current startup requires
schema through **0035**. Do not delete an existing database to upgrade it.

API commands use the **repository-root `.env`**, copied from the root `.env.example`.
Do not create `apps/api/.env`: it is not loaded by the commands below. Migrations use
that same root file. Web-only public addresses belong in `apps/web/.env.local`;
launch-site configuration, if present, belongs to the separate docs app.

Keep authentication and encryption keys stable, and back up the private data directory
with PostgreSQL. API commands retain their working directory so relative data paths
remain stable. Services can supply environment variables instead of a file; explicitly
supplied variables take precedence.

With dependencies installed and configuration prepared:

```bash
cd apps/api
bun run dev
```

The default API listener is `127.0.0.1:3002`. Open `http://localhost:3000` for the builder;
the web server forwards its `/api` requests here. Listener settings are
`WRENLY_API_HOST`/`WRENLY_API_PORT`; align the web application's `NEXT_PUBLIC_API_URL`
when changing the address. An occupied port fails instead of silently choosing another.

Every instance requires Better Auth sign-in. To create the first owner, run
`bun run setup` in another terminal from this directory and open the private one-time
link. Further accounts require invitations. See [first-owner setup](../docs/content/docs/guides/instance-setup.mdx).

## Reconcile interrupted publishing

From the repository root, after verifying the exact remote job has settled:

```bash
bun run reconcile-deployment DEPLOYMENT_UUID --confirm-remote-settled
```

This command reads the same root configuration as startup. It checks the saved
operation and permits an explicit new attempt; it does not publish or certify the
remote application's health. Follow the complete [publishing recovery guide](../docs/content/docs/reference/publishing-operations.mdx).

## Find the code

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | Validate configuration/schema, open listeners, start and stop workers |
| `src/app.ts` | Register explicit Hono routes with injectable handlers for tests |
| `src/production-app.ts` | Connect those handlers to server-only services |
| `src/config/` | Validate environment settings before startup |
| `src/modules/` | Feature-specific access checks, HTTP handlers, persistence and execution |
| `src/lib/` | Shared logging |

Start with each module's README. Builds own generation and Docker validation;
conversations own answers, planning and explicit build actions; MCP owns framework-tool
connections. Projects own access, settings, drafts and archive. Auth owns instance
identity and membership. Models own connection configuration and discovery. Skills own
saved instructions. Previews and deployments have separate lifecycles.

Hono registers routes in code, rather than using Next.js filesystem routing. The
[HTTP reference](../docs/content/docs/reference/http.mdx) explains the public contracts.
A route table is not authorization: every handler must retain its current-session and
project-access checks. Instance administration never grants access to private projects.

## Work survives browser navigation

A build is a saved request to generate and validate code. A worker claims it and records
progress in PostgreSQL. Closing a tab stops observation, not execution. Reopening the
project reads saved progress and subscribes again. Only explicit cancellation requests
stop work; uncertain interrupted operations require recovery rather than silent replay.

The composer offers Auto and Plan. Plan answers and refines requirements without
building. Auto can answer or admit a build through the existing atomic action path.
Historical Ask/Build records remain readable. Both Next.js and Laravel use versioned
MCP edits for existing revisions; omitted files survive and incomplete context fails
explicitly. See [conversation architecture](../docs/content/docs/architecture/conversations.mdx).

Local previews and publishing are opt-in and require their documented toolchains.
Publishing runs sandbox-built images by exact registry digest; it never rebuilds source
in Coolify. See [local previews](../docs/content/docs/guides/local-previews.mdx) and
[publishing setup](../docs/content/docs/guides/publishing-setup.mdx).
Generated-app database helpers remain internal: their worker, HTTP API and viewer are
not activated. Do not infer a supported product feature from the presence of helpers.

## Verify a change

From this directory:

```bash
bun run check-types
bun run lint
bun run build
```

From the root, `bun test` runs the default suite; opt-in database, browser, Docker and
real-provider checks are separate. Follow [CONTRIBUTING.md](../../CONTRIBUTING.md) and
the affected module's test instructions. Use disposable test databases, never instance
data. A successful build does not prove live model, preview or deployment acceptance.

Build output in `dist` excludes inlined environment values. Run `bun run start` only
with the installed workspace and runtime configuration available: shared packages and
MCP server sources are runtime dependencies, not bundled standalone applications.
