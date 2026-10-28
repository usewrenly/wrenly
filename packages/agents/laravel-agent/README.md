# Laravel MCP server

You ask Wrenly to “Build a team directory.” This package sends framework-specific
instructions to your selected model and returns application files. It does not run
those files or deploy the app. The API calls its tools through MCP: a standard way
for one program to ask another program to perform a named operation.

## Finding the code

- `src/server.ts` exposes tools over the process input/output pipes and returns safe errors.
- `src/index.ts` builds model messages and parses generated source.
- `src/edit-prompt.ts` contains framework-specific editing instructions.
- `@wrenly/inference` owns shared edit types, validation and their unit tests.

A revision is a saved set of files. An edit returns only explicit changes; the API
keeps files that were not mentioned. A repair attempt includes previous build errors
so the model can correct them. The API owns retries; the model SDK does not retry on
its own. Initial generation rejects unfinished answers and bounds response text.


Compatibility package name: `@wrenly/laravel-agent`. This is a framework MCP server,
not an autonomous orchestrator. Wrenly starts it over stdio; it exits on parent EOF.

Targets **Laravel 13 and PHP 8.4**, with Blade and local CSS/assets. It exposes
`generate_app` and `edit_app_v1`. Model inference uses the API-selected server-side
OpenAI-compatible connection. No browser provider calls or extra external account.

## How this differs from Laravel MCP and Boost

Imagine three different requests: “build a booking app,” “inspect this Laravel app,”
and “create a booking through my existing app.” They need different tools even when
all three tools communicate through MCP.

This Wrenly server handles the first request. It uses the MCP TypeScript SDK to expose
generation/editing tools, sends Laravel-specific instructions and a skeleton to the
selected model, and returns source files. The API separately owns retries, Docker
validation, saved revisions and publishing. It does not currently use Laravel Boost
or the `laravel/mcp` PHP package.

[Laravel Boost](https://laravel.com/framework/docs/boost) helps coding assistants work
with an existing Laravel application: framework guidance, documentation search and
application inspection/development tools. [Laravel MCP](https://laravel.com/blog/laravel-ai-sdk-boost-or-mcp-which-tool-do-you-need)
is the PHP library for exposing an application's own tools to AI clients. Boost itself
uses that library. Neither implements Wrenly's generation/editing contract or replaces
its sandbox and resource lifecycle.

Boost could complement a future development-tool loop, but is not installed or called
automatically. Its code-execution/database tools would require deliberately scoped
authorization and sandboxing; hosted documentation search cannot become a requirement
for an offline Wrenly instance. MCP is the shared protocol, not permission to execute
every tool a server offers.

Generation returns structured `files`, `build_command` and `start_command` metadata.
Wrenly selects trusted sandbox commands; returned command metadata is never authority
to execute model-selected commands. Editing returns version 1 create/update/delete
operations; the MCP client merges these into the complete frozen revision. Omitted
files stay unchanged. Unsupported older framework revisions are not silently upgraded.

The default skeleton supplies Laravel bootstrap/configuration files. It does not
invent database tables, authentication flows or external integrations. The model
supplies the requested views, routes and local assets. UTF-8 content is supported.

## Local prerequisites

From the repository root, build the operator-owned toolchain once:

```bash
docker build -t wrenly/laravel-runtime:13-php8.4 packages/sandbox/images/laravel
```

This image uses FrankenPHP on port 3000, PHP 8.4, Composer and Bun. It serves previews
and production artifacts without Nixpacks or the PHP development server. The application
still runs only in Wrenly's resource-limited sandbox. Host PHP/Composer is not needed.
Generated Dockerfiles are never used to build this trusted toolchain.

Composer installation runs with plugins/scripts disabled, then audits locked packages.
Root scripts/custom repositories/security-policy overrides are rejected. Optional Bun
assets install with scripts disabled. PHP/Blade checks, asset compilation and an actual
HTTP/CSS probe run with network disabled. No security-advisory bypass is provided.

## Verification

```bash
bun test packages/inference/tests/unit/edit-contract.test.ts packages/sandbox/tests/laravel-source.test.ts
WRENLY_TEST_MCP=true bun test apps/api/src/modules/mcp/tests/integration/laravel-generation.integration.test.ts
WRENLY_TEST_LARAVEL=true bun test packages/sandbox/tests/laravel-runtime.integration.test.ts
```

The last command needs the trusted image and local Docker. Tests create disposable
containers/volumes and remove their retained artifact image. Add
`WRENLY_TEST_LARAVEL_BROWSER=true` for Chrome assertions/captures. Tests use fixture
inference/source; they do not certify the output quality of every model.

User setup and publishing instructions are in the public documentation under
`apps/docs/content/docs` (frameworks and publishing guides).

## Current limits

- Database provisioning, migrations, persistent uploads, queue workers and schedulers
  require the separate generated-app resource lifecycle work. Do not advertise these
  as working because a stateless Laravel page works.
- No legacy Laravel 11/12 auto-upgrade. Create a new Laravel project for this runtime.
- Editing requires the complete revision to fit the existing 128 KB context budget.
- Published application keys are stable, encrypted and delivered at runtime; previews
  use temporary keys. Keys are not committed to Git or generated into environment files.
- Registry/Coolify publishing remains opt-in, with separate live deployment acceptance.
- Public base images/dependencies must be available during initial preparation. Offline
  application execution does not mean uncached dependencies can be installed offline.

## Project Skills input

Generation and `edit_app_v1` accept optional `skills_v1`, declared by the shared
`SKILL_GUIDANCE_SCHEMA` from `@wrenly/inference`. Immutable documents/IDs/hashes are
validated before inference and remain untrusted guidance below system/source/security
policy. Guidance counts against the editing budget; neither source nor instructions
are silently truncated. Repairs/retries receive the admitted snapshot, never a lookup
of the current library. Skills grant no tools or sandbox/network permission.

The API checks explicit version1 capability. Community stack implementations should
reuse this shared contract or reject selected skills clearly; silently ignoring them
is unsupported. Single-document instructions do not install scripts/resources.
