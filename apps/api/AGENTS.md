# API contributor instructions

Read root AGENTS.md and PROJECT_BIBLE.md, then this app's README and the affected
module's README. Root architecture/security rules still apply. Hono on Bun hosts this
API; Next.js hosts the web and documentation apps only.

## Entry points and configuration

- `src/app.ts` registers explicit routes with injectable Request/Response handlers.
- `src/production-app.ts` connects server-only services; `src/index.ts` validates
  configuration and persistence before starting listeners and workers.
- Apply all checked-in Drizzle migrations before startup; the current schema requirement
  is through 0035. Do not treat an older feature's migration number as the startup minimum.
- Keep files in their feature folders under `src/modules`. Reuse shared contracts rather
  than duplicating types. Do not import next/headers or next/server into API handlers.
- Never inline environment values into bundles or print secrets in diagnostic output.

## Access and saved work

- Better Auth sessions are mandatory, including one-person installations. Never seed a
  fixed identity, expose raw public signup or mount private provisioning SDK handlers.
  First-owner setup requires operator proof; invitations authorize further accounts.
- Preserve current account/session checks, owner/member distinctions, project roles and
  actual actor attribution. Instance ownership is not access to another user's project.
  Owner-only administration/publishing and Editor/Viewer boundaries remain distinct.
- Acquire locks in the established queue → account → project/draft order. Preserve
  active/unresolved-work blockers, revision checks and exact action replay. A revision
  check rejects a save based on stale state; replay returns the saved result for the
  same action identity instead of performing that action twice.
- Builds and conversations execute from persisted worker claims, never browser-owned
  subscriptions. Preserve leases, operation locks, ordered replay events and awaited
  shutdown. Do not automatically repeat an operation whose external effect is unknown.
- Auto/Plan are current composer choices. Plan cannot admit builds. Keep historical
  Ask/Build compatibility and the existing atomic conversation-to-build admission path.
  Editing uses complete saved context and explicit MCP edit operations; never regenerate
  an existing app as a fallback for incomplete context or unsupported edits.

## Runtime and credential boundaries

- Framework communication uses MCP only. Next.js and Laravel share the bounded model
  transport in @wrenly/inference; MCP subprocesses must not auto-load .env files.
- Resolve the selected saved connection during admission. Workers decrypt only that
  connection. Do not persist tokens in jobs, retarget credentials from registry metadata
  or silently substitute a different model when a binding is unavailable.
- Freeze selected Skills text/version/hash with admitted work. Retry uses that saved
  guidance, not the current personal library. Skills never grant tools or networking.
- Preview traffic uses a separate origin and revision/session-bound authorization.
  Preserve grant revocation, exact owner-approved media origins and blocked script/API
  egress. Media permission is not model browsing or container-network permission.
- Publishing uses the opt-in durable artifact executor, private source snapshots and
  exact sandbox-built image identity. Never restore source-rebuild/Nixpacks/public-clone
  adapters. Preserve mutation intent, provenance, operation locks and explicit recovery.
- Generated-app Development databases require the validated WRENLY_APP_DATABASES_ENABLED
  opt-in, local previews and coordinated host preflight/shutdown. Production database
  provisioning/publishing stay unavailable. Do not activate an operator instance during cleanup. Preserve their admission blockers and the narrow
  trusted provisioning exception; no browser/model SQL or control-cluster app databases.
- Retain bounded profile decoding, authenticated local picture retrieval, member-access
  fencing, invitation proofs and native endpoint restrictions when modifying auth.
- Archive preserves history/resources and blocks new work. Restore never restarts jobs.
  Draft reads/writes do not call inference or automatically create/build a project.
- Public history/activity contains approved operation metadata, never raw model thinking,
  provider errors, credentials, claims or internal mutation intents. History reads never
  call external providers or grant extra access to administrators.

## Verification and documentation

Run `bun run check-types`, `bun run lint` and `bun run build` here, and relevant tests
from the root. Follow module-specific instructions for opt-in integration suites; use
only guarded disposable databases. Do not confuse default-suite success with real
provider, Docker or publishing acceptance.

Public comments must explain purpose and decisions without private planning links.
Teach concepts in plain English before naming abstractions. Update the relevant public
MDX guide when behavior changes. New non-trivial components still require a reviewed
self-contained design before implementation; routine authorized review fixes do not
require a new architecture approval.
