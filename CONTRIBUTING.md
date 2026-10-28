# Contributing to Wrenly

Wrenly turns a conversation into a validated app on the user's infrastructure.
For example, a booking-app prompt goes through the API, a framework tool server and
Docker validation before its saved revision appears in the workspace. The tool server
uses MCP (Model Context Protocol): it exposes generation/editing tools that the API
calls through a shared protocol instead of importing framework code directly. Start with
[the architecture guide](apps/docs/content/docs/architecture/overview.mdx) and
[repository map](apps/docs/content/docs/architecture/project-structure.mdx).
Read [AGENTS.md](AGENTS.md) for repository rules; the project Bible provides additional
maintainer context. Do not infer shipped support from a placeholder package.

## Local development

Use Bun 1.3.14 and Node 24 or newer, plus Docker for PostgreSQL and isolated generated
app execution. Follow the README and [installation guide](apps/docs/content/docs/guides/installation.mdx).
Every installation requires Better Auth sign-in. Never bypass authentication for a demo.
Keep `.env`, local keys, generated code and instance data out of commits.

Run the fast checks from the root:

```bash
bun install --frozen-lockfile
bun audit --audit-level=high
bun test
bun run check-types
bun run lint
bun run build
```

The default suite deliberately skips opt-in PostgreSQL, MCP, Docker and browser fixtures.
A green default test run does not verify real inference, sandbox images or deployment.
The [CI workflow](.github/workflows/ci.yml) separately exercises owner/invitation setup,
member-access upgrades, provider configuration and saved Skills with empty, explicitly
named local test databases. It also applies migrations twice to check repeatability.
Never point test variables at an operator database.
Specific integration fixtures validate their database names/hosts and may remove fixture
rows. Use a disposable PostgreSQL instance. Docker/browser/toolchain acceptance stays an
explicit release check; it is not silently represented by CI's default tests.

## Keep changes reviewable

Use feature folders and existing boundaries: API `src/modules/<feature>`, pure shared
contracts in packages, Drizzle schema/migrations in `packages/db`, and separate browser
components/contracts. Tests belong beside the feature or its package's existing tests
folder. For example, a provider's HTTP adapter belongs under that provider's feature,
while a reusable HTTP helper has its own responsibility. Keep each move reviewable;
avoid coupling an unrelated repo-wide relocation to a behavior fix.

Use strict TypeScript, explicit exported return types, established technical terms and
bounded structured errors. No `any`, browser inference calls, raw model SQL, credential
logging or generated code outside Docker. MCP clients call framework-server tools;
model providers and deployment/repository adapters are separate responsibilities.
Existing `*-agent` names are compatibility identifiers.

For a new non-trivial component, write the design/pseudocode, confirm it with the
maintainer, then implement. Keep the design beside the component in `DESIGN.md` or
a self-contained header comment. Include purpose, inputs, outputs, steps, edge cases
and error behavior. Preserve old snapshots/retry identity, current-session authority and
ordered durable admission; do not “repair” an uncertain side effect by blindly rerunning it.

Use Conventional Commits and one concern per PR. Explain what changed, why, how it was
tested and any remaining limits. Add/update the relevant MDX guide and keep the component design self-contained.
New framework MCP servers must meet AGENTS.md's checklist, including integration tests,
structured errors, EOF shutdown, revision editing and actual sandbox verification.
Don't advertise roadmap frameworks or providers as implemented.

## Reporting a problem

Include reproduction steps, versions, expected/actual behavior and sanitized logs.
Remove tokens, account emails, private source and one-time setup/removal links.
For a suspected security issue, follow [SECURITY.md](SECURITY.md) instead of a public issue.

## Reviewing outside contributions

A pull request is proposed code, not trusted code. Read its diff before running it on a
machine with credentials or access to Docker. A changed test, package install hook or
workflow can execute code too. Use a disposable environment for unfamiliar contributions;
never give a fork your model, deployment, registry or production database credentials.

Our CI uses read-only repository permission, pinned action commits and fixture-only
credentials. It does not deploy or run real model requests. Maintainers should require
the existing checks on the intended merge commit and review workflow/dependency changes
carefully. Do not use `pull_request_target` to run untrusted checked-out code with secrets.
See [GitHub's workflow security guidance](https://docs.github.com/en/actions/reference/security/secure-use).

Keep a PR small enough to explain and review. A green check helps catch mistakes; it
does not prove a change is safe. Security reports follow SECURITY.md, not public issues.

The advisory check contacts the package advisory service with dependency information.
CI blocks high/critical findings. Run `bun audit` to see all severities; a passing gate
is not a zero-advisory report or a security audit. Review lower-severity findings by
actual dependency path and affected API before deciding whether to update or defer them.
