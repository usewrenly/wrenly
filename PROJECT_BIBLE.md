# Wrenly project Bible

Wrenly helps people turn an idea into an application without giving up control of where
it runs or which AI model they use. This document explains the shared concepts and
conventions. Start here when contributing; use the public handbook for installation and
user workflows.

For example:

> A team asks for a booking app. Wrenly saves the request, asks its selected model for
> code through a framework tool server, validates the files in Docker and saves a revision.
> The team can inspect that source, open an isolated preview, request a change and publish
> a successful revision through configured private infrastructure.

A generated page is not automatically a deployed production service. Those are different
steps, with different evidence and permissions.

## Current scope

Next.js and Laravel workflows cover generation, ongoing editing, validation, local
previews and private publishing. Framework servers are extensible through MCP. Vue and
Django are planned; their folders are not implemented support.

Accounts, private invitations, project Viewer/Editor roles, saved conversations/revisions,
source downloads, drafts, reversible archive, model configuration and versioned Skills
are connected. Development app databases are **Experimental**, require explicit setup
and remain off by default. Production database provisioning and database-backed publishing
are unavailable. External MCP connectors such as Figma, alternative Git hosts/deployers,
a packaged installer and a hosted Wrenly service are separate roadmap work.

The roadmap is honest product scope, not a promise of completion dates. Follow the
repository’s tagged release notes for the version actually installed.

## Find your way around

```
apps/
  web/       browser UI and same-origin API forwarding
  api/       Hono API, authorization, saved requests and workers
  docs/      public Fumadocs handbook and local search
packages/
  agents/    framework-specific MCP tool servers
  inference/ shared model connection and instruction rules
  sandbox/   isolated validation, runtime images and previews
  deploy/    private source snapshots and deployment-provider adapters
  db/        PostgreSQL schema, migrations and shared database contracts
  ui/        shared components, brand artwork and styling foundations
```

Applications build/deploy; shared packages are consumed by those applications. Root
contains project reference/configuration files, not another application. Within a module,
group files by responsibility instead of collecting unrelated services under a vague name.
Its README should explain those responsibilities before listing paths.

## Words we use

| Word | Plain-English meaning |
| --- | --- |
| Model provider | The service hosting an AI model, such as a configured hosted endpoint or local Ollama |
| Model | The particular model identifier selected on that connection |
| Inference | Asking that model to produce an answer, plan or code |
| MCP server | A process exposing framework tools using Model Context Protocol |
| MCP client | The API-side connection that calls those tools |
| Build | One saved generation-and-validation request |
| Attempt | One try within that build's limited repair loop |
| Revision | A saved version of generated source and its outcome |
| Preview | An isolated running copy of a selected successful revision |
| Deployment | A separate request to publish a runtime image to configured infrastructure |
| Migration | A versioned instruction for changing database structure |
| Claim/lease | A worker's temporary authority to execute a saved request, with an expiry |
| Revision check | Refusing a save if another change made the user's earlier view stale |
| Frozen input | The exact saved settings/context reused even if current preferences change |
| Digest | A content fingerprint identifying exact source, migrations or image bytes |

Existing `nextjs-agent` and `laravel-agent` package names are compatibility names. Their
implemented responsibility is framework tools, not an invented autonomous multi-agent
planner. Skills are reusable instructions; they do not grant executable tools.

## Follow a request

```
Browser → authenticated Hono API → PostgreSQL saved request
                                     ↓
                              claimed worker
                                     ↓
                          MCP client → framework MCP server
                                           ↓
                                  selected model connection
                                     ↓
                           files → Docker validation
                                     ↓
                          saved revision / authorized replay
                                     ↓
                       explicit preview or publishing request
```

The browser can disconnect or reload without owning execution. Persisted request IDs
prevent an acknowledged action from being repeated accidentally. Workers hold temporary
claims and local execution locks; expired or uncertain work stops for explicit recovery.
“Cleanup succeeded” does not mean an earlier external action succeeded.

Auto can answer, clarify or start a validated build for a clear request. Plan discusses
without admitting builds. Edits receive the complete selected revision and explicit
operations; an omitted file is preserved rather than silently deleted. Retry uses saved
settings and the existing bounded budget, not whatever model/default changed afterward.
Assistant responses and observable execution events are separate; do not expose hidden
model reasoning as fabricated tool progress.

## Authentication and collaboration

An instance is one installation of Wrenly. Even its sole owner signs in. Protected local
setup opens a one-time browser flow to create the first account; more people join through
private invitations. Better Auth owns passwords and sessions. No external Wrenly account
or anonymous single-user bypass is involved.

A project starts Private. Its owner can grant selected accepted members Viewer/Editor
access or share with Everyone on the instance. Everyone does not mean the internet.
Viewers read permitted artifacts; Editors contribute with the bound project model;
only owners control sharing, project model, resources and publishing. Instance owner
administration is not an override to read someone else's private project.

Recheck authority for reads, writes, workers and preview sessions. Preserve actual actor
attribution and lock order (queue, account, then project/resource). Access reductions wait
for active/unresolved work to finish and revoke relevant preview access. Archive retains
history/resources; restoring a project does not restart old jobs.

## Generated execution and delivery

Generated code is untrusted. Docker bounds CPU, memory, process count and execution time.
Package installation has constrained access and disabled hooks; subsequent validation
runs offline. Runtime credentials never enter source snapshots or prepared image layers.
Previews use a separate origin and session/revision-bound access, not a public control API.

Private publishing stores source in Gitea, promotes the sandbox-built image through a
private registry and configures Coolify with that exact image. Stable application secrets
are delivered at runtime. These are initial integrations, not a claim that GitHub/GitLab
or every deployer is already selectable. Generic source snapshot work and provider HTTP
APIs have different responsibilities; their package README explains the boundary.

An app database is separate from Wrenly's control PostgreSQL cluster. The owner explicitly
creates/selects Development; the model writes application connection code and migrations.
Disposable validation does not mutate saved Development data. Persistent changes require
reviewed source/migrations, a verified backup and explicit confirmation. Generated runtimes
receive scoped Unix sockets rather than unrestricted IP access or control credentials.
Confirmed compiler failure plus verified cleanup may return to repair; unknown effects
still require recovery. Production databases remain unavailable.

## Conventions and why they exist

Use Bun/Turborepo, strict TypeScript, Next.js App Router, Hono, Zod, Better Auth,
PostgreSQL/Drizzle, MCP, Docker, shadcn/ui/Tailwind and Fumadocs. Discuss changes to that
stack first; replacing one layer can change deployment, security and contributor costs.

Use established technical names consistently. Export explicit return types, narrow unknown
input and avoid any/type-check suppression. Name limits and explain non-obvious choices.
A comment should explain why a decision exists, not repeat the next statement. Explain
an exported boundary's purpose, callers, inputs and failures where that is not obvious.

Before non-trivial code, write and confirm a self-contained design: purpose, inputs,
outputs, steps, edge cases and errors. Keep it beside the component. An unfamiliar reader
should not need private planning notes to understand public source.

Drizzle owns ordinary queries and migrations. The narrow provisioning exception permits
fixed, validated SQL templates through Drizzle for PostgreSQL role/database/grant setup;
it is not permission for model-written control SQL. Configuration is startup-validated,
documented in .env.example and private in real installations.

## Verify and maintain

Default tests, type checks, lint and production builds are separate checks. Guarded
PostgreSQL, native decoder, Docker, MCP and browser acceptance prove additional boundaries;
a skipped fixture does not pass them. Hosted CI must check the exact intended commit.
Dependency advisory checks catch known vulnerable versions, not every possible flaw.

Use disposable data for tests. Preserve stable keys with matching control-data/config
backups and test restoration separately. Never reset a live installation to make a test
pass. Source history, local instance data, private repositories, runtime images and app
databases have distinct backup requirements.

CONTRIBUTING.md explains local checks and PR scope. SECURITY.md explains private reporting.
Keep user documentation practical: what to do, what it means, what should happen and how
to recover safely. Keep release notes honest about verified capabilities and limitations.
