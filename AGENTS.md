# AI contributor instructions

Read PROJECT_BIBLE.md before significant work. It explains what Wrenly does, how a
request moves through the system and why the boundaries matter. Read a module's README
and any nearer AGENTS.md before editing it. These rules apply to AI-assisted contributions.

## Start with the current product

Wrenly is a self-hostable AI app builder for developers, agencies and teams. Next.js
and Laravel are implemented. Vue/Django and external MCP connectors are planned;
placeholder packages do not establish support. Development app databases are Experimental,
off by default; Production databases and database-backed publishing are unavailable.

## Keep the stack and responsibilities

- Bun, Turborepo and strict TypeScript; Node24+ where dependencies require it.
- Next.js App Router for web/docs; Hono on Bun for orchestration, Zod for validation.
- Better Auth for every installation; PostgreSQL and Drizzle for persistence.
- MCP clients call framework MCP servers; no direct framework imports into orchestration.
- Docker for every generated build/runtime; Coolify/private-registry publishing.
- shadcn/ui and Tailwind for UI; Fumadocs for public documentation.
- `apps/` contains deployable applications, `packages/` shared code; no applications at root.

Do not introduce a replacement technology or architectural pattern without discussing
it and documenting the decision in the Bible.

## Design before implementation

For a non-trivial component, write the design, confirm it with the maintainer, then code.
Use a self-contained DESIGN.md beside the component or a header comment containing:

```
COMPONENT: name
PURPOSE: why it exists
INPUTS: what comes in
OUTPUTS: what leaves
STEPS: ordered behavior
EDGE CASES: concurrency, stale state, cancellation
ERROR STATES: how failures are handled
```

Keep the explanation understandable without private planning material. One concern per
change; avoid unrelated file moves or large cleanups during a behavior fix.

## Code strangers can understand

Use established names consistently in UI, contracts and code: model/provider, MCP
client/server, build/attempt, revision, preview and deployment have different meanings.
Existing `*-agent` package names are compatibility identifiers for MCP servers, not proof
of autonomous planning. Files/folders use kebab-case; React component symbols and types
use PascalCase; functions use camelCase; constants use SCREAMING_SNAKE_CASE.

- No `any` or type-check suppression. Narrow unknown input; export explicit return types.
- Comment purpose and non-obvious reasons, not a narration of each statement.
- Name limits/timeouts; explain their purpose. Do not scatter magic numbers.
- Handle async failures explicitly. Use bounded readable errors and contextual logger
  calls, never console.log or raw secrets/stack traces in user responses.
- Teach before naming abstractions in READMEs: a simple Wrenly example, then terminology,
  paths, contracts and limitations. Define unfamiliar terms when first used.
- Shared cross-package contracts belong in their owning shared package, not copied types.
- Use existing feature folders and tests; keep public source comments self-contained.

## Security and saved-work boundaries

1. Browser code never calls model providers. Inference and credentials stay server-side.
2. Generated code runs only in Docker:2CPU,2GiB, five-minute bounds; network disabled after
   constrained installation. Never weaken this boundary to make a build succeed.
3. Every person signs in through Better Auth, including a one-person instance. Protected
   browser setup creates the first owner; further accounts require private invitations.
   Legacy single-user configuration never permits anonymous access.
4. Membership is not private project access. Recheck sessions, account state and project
   capabilities server-side. Preserve actual message/build actor identity and Viewer/Editor/
   owner distinctions. Instance administration is not another project's ownership.
5. Use Drizzle and migrations for control data. The narrowly scoped provisioning exception
   permits fixed validated Drizzle SQL templates for PostgreSQL roles/databases/grants only;
   it does not permit a model SQL console or generated access to the control cluster.
6. Workers execute persisted requests, not browser subscriptions. Preserve request identity,
   ordered queue/account/project locks, claims, expiry, cancellation and explicit recovery.
   Never rerun an external action whose result is unknown.
7. Auto answers/clarifies/builds; Plan cannot build. Edits start from the selected saved
   revision, preserve unchanged files and use versioned MCP edit operations. Retry retains
   saved settings/context and the existing bounded attempt budget.
8. Skills are reviewed versioned instructions, not scripts/tool permissions. Freeze selected
   text/hashes during admission; do not read changed personal library text during execution.
9. Previews have separate origins, revision/session-bound access and exact owner-reviewed
   media origins. Media permission is not model browsing or container/API networking.
10. Publishing promotes an exact sandbox-built image through private source/registry/
    Coolify adapters. No source rebuild, public clone, runtime secrets in Git or provenance
    bypass. Archive never deletes remote resources or automatically restarts work.
11. Development databases use separate storage/roles and authenticated Unix-only sockets.
    Preserve independent cleanup evidence, verified backups, reviewed migrations and
    Production separation. A failed preparation receipt is never image provenance.
12. Keep authentication, provider/deploy encryption keys and account pictures on the
    instance. No telemetry or required external Wrenly account. Optional provider choices
    are explicit; offline operation uses locally installed models/toolchains.

Environment values belong in .env.example with explanations and startup Zod validation.
Never commit private .env, keys, generated private source, local storage or one-time links.
Keep deterministic execution/configuration failures separate from unconfirmed effects.

## Validation and contributions

Run the relevant tests plus root `bun test`, `bun run check-types`, `bun run lint` and
`bun run build`. CI also checks high/critical dependency advisories and guarded PostgreSQL
acceptance. Opt-in skips are not evidence of live model, Docker, browser or publishing
acceptance. Never point destructive fixtures at an actual instance database.

Routing/retry changes need unit tests; API changes need happy/error paths; MCP servers
need structured prompt→file-tree integration checks. Sandbox changes need Docker checks.
Update the public MDX guide with behavior changes. New framework servers must support
MCP, structured errors/files/build/start commands, complete-context editing, parent EOF
shutdown, documented versions/limits and genuine sandbox/runtime acceptance.

Use Conventional Commits and focused PRs explaining what, why and verification. Follow
CONTRIBUTING.md and SECURITY.md; report suspected vulnerabilities privately. Never publish,
deploy, change live storage or send messages as a side effect of a code review.
