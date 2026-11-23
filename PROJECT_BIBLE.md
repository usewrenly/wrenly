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

Optional voice dictation runs locally through a pinned Whisper.cpp Docker runtime.
A person records up to 60 seconds, reviews the transcript and inserts it into a draft;
Send remains explicit. Audio is temporary, not a saved attachment or cloud service.
See the public voice-dictation guide for the one-time model/runtime setup.

Optional official framework inspection adds isolated Laravel Boost package facts and
Next.js 16 DevTools error state to stateless repair attempts. It is off by default,
uses a fixed offline browser visit for Next.js, and never grants live database or
model-driven browser access. See the public framework-inspection guide.

Next.js and Laravel workflows cover generation, ongoing editing, validation, local
previews and private publishing. Framework servers are extensible through MCP. Vue and
Django are planned; their folders are not implemented support.

Accounts, private invitations, project Viewer/Editor roles, saved conversations/revisions,
source downloads, drafts, reversible archive, model configuration and versioned Skills
are connected. Development app databases are **Experimental**, require explicit setup
and remain off by default. Production database provisioning and database-backed publishing
are unavailable. External MCP connectors such as Figma, alternative Git hosts/deployers,
a packaged installer and a hosted Wrenly service are separate roadmap work.

GitHub source connections support browser App setup, personal repository import and
owner-reviewed pushes to new branches. They are separate from app publishing and
MCP connectors. Import detects the framework from root manifests and preserves
Next.js 15/16 or Laravel 12/13 dependency constraints. New-project starters are a
separate choice; importing or editing never silently upgrades an existing app.
Real provider acceptance is required before releasing this feature.

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
  source-control/ GitHub repository identities, bounded source reads and change review
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

## Infrastructure adapters and framework tools

A framework MCP server helps generate or edit source. An infrastructure adapter
talks to a Git host, deployer or database service. Those responsibilities stay
separate. For example, a future deployer can replace Coolify's API calls while
Wrenly keeps the same owner checks, saved requests and recovery rules.

The internal database-provider contract lives in `packages/deploy/src/databases`.
A saved provider ID selects an explicitly configured, compiled-in adapter. The
adapter interprets its own placement fields and returns an opaque remote identity.
Missing adapters fail closed; existing resources never silently move to another
provider. Common orchestration owns credentials, work claims, locks and explicit
recovery. A provider reporting TLS enabled does not replace a real verified TLS
connection check. This extension boundary does not mean other deployers are
implemented, nor does it expose infrastructure operations as model MCP tools.

## Production app database isolation decision

Generated apps will share one dedicated, privately reachable PostgreSQL 17 cluster,
with a separate database and restricted migrator, runtime and reader accounts per
project. A cluster means one PostgreSQL server installation. It must never be the
cluster containing Wrenly accounts, prompts or project metadata; authenticated server
identity checks reject that configuration even when hostnames differ.

This supports one-time infrastructure setup followed by dashboard-managed project
provisioning. Verified TLS protects the private upstream connection. Generated apps
retain the existing role-scoped socket boundary and blocked IP egress. Database
creation and grants are separate durable steps: interrupted creation must be inspected,
not repeated blindly or adopted by matching a name. Existing passwords are never
silently replaced. PUBLIC privileges are changed only on the newly created project
database, never across the shared cluster.

This is database-and-role isolation, not machine isolation. CPU, storage, maintenance,
WAL and server outages remain shared. The management credential is highly privileged
and stays instance-side; project credentials cannot create databases or roles. Future
infrastructure adapters may support other placements without changing owner review,
backup or recovery rules. Production activation remains gated on complete runtime,
recovery, publishing and UI acceptance.

## Deployment-host transport decision

A database socket is a file on the machine running the generated app. Giving a remote
Coolify server a local volume name does not move that socket to it. Database-backed
publishing therefore needs verified access to the deployment machine as well as the
private PostgreSQL server.

The deployment adapter uses a repository-owned fixed helper on that machine. Same-host
operations can use the existing local Docker transport. Remote operations use SSH—an
encrypted connection to a specifically trusted machine—with an explicitly pinned host
key and a dedicated instance-owner credential. Generated code cannot choose the host,
command or mounts. Host setup is separate from project publishing permissions.

Runtime-role configuration travels through the helper's standard input, never command
arguments, Docker environment metadata, Compose files or repositories. The generated
application keeps IP networking disabled; a trusted ingress bridge and database broker
provide only its HTTP and role-scoped database sockets. Every application image remains
pinned to its validated digest. Existing stateless image publishing retains its adapter.
This path becomes available only after the complete host, lifecycle and deployed-data
acceptance checks pass.

## Database requests in the conversation

“Build a notes app that remembers notes” first offers the project owner a Development
database proposal. Approval saves the requested instructions and exact model, Skills
and source context; background work creates/connects the resource and admits one build.
After generation, a second card presents the saved migration files. Its separate approval
authorizes verified backup, disposable rehearsal and application of that exact review.
No model response grants permission to change saved tables. Plan remains discussion only.

Migration 0049 stores these continuations. A continuation means the next saved step after
an operation finishes. Each operation has a stable request ID, so restart/reload observes
its existing receipt. Stop prevents later phases; sign-out and access changes remove the
authority needed to continue. Unknown effects remain blocked for inspection. The Database
tab retains advanced resource controls. This Development flow does not automatically
publish an app or promote its data to the separately configured Production environment.
