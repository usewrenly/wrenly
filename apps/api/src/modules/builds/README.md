# Building an app without depending on an open browser

A **build** asks a framework's MCP server to generate or edit code, then checks that
code inside Docker. An **attempt** is one try within the build; a failed check can feed
its error into another bounded repair attempt.

For example:

> Submit “Add a booking calendar” → refresh the browser → the server keeps working →
> reopen the project and read its saved files, progress and result.

The browser watches saved work. It does not own the worker that performs it.

## Find the code

```text
admission/       Validates a request and saves one queued build
persistence/     Stores worker ownership, progress, results and authorized reads
execution/       Worker loop, MCP/Docker attempts and real resource bindings
http/            Request/status/event handlers and progress/log helpers
tests/unit/      Admission, executor, worker and HTTP rules with controlled adapters
```

`admission/build-contract.ts` owns the request schema. `persistence/build-job-store.ts`
owns the claim/progress/outcome types. Other modules import these definitions.
The old request-owned executor and historical adapter are removed; there is one
production execution path, not two implementations to keep in sync.

## Remember the choice before doing the work

**Admission** means checking and saving a request before accepting it. It checks current
project permission, queue limits and the selected source/model/skill instructions.
A unique **idempotency key** identifies that submission. If its reply is lost, sending
the same key returns the existing build instead of creating another.

An explicit Retry creates a new build from the earlier saved settings and errors.
A follow-up prompt creates new work using its chosen base version. These are different
requests. Publishing remains separate: `deploy:true` cannot turn generation into deploy.

An internal database-enabled request can also save a non-secret `databaseV1` selection:
the exact ready Development resource and its revision. Admission checks current project
authority; explicit Retry preserves the saved choice and refuses a changed resource.
Omitting it keeps a build stateless. The ordinary UI/HTTP/conversation path does not
populate this setting yet, and the normal worker still uses stateless validation.

## Only the current worker may save progress

A **claim** identifies the worker that owns the build. A **lease** expires unless that
worker renews it. Every saved update checks ownership, so a worker that lost its claim
cannot overwrite newer state. Progress events and source updates commit together.

The executor saves generated files before Docker validation. Failed builds therefore
keep useful source and diagnostics. Existing Next.js/Laravel revisions use MCP editing
with complete source, preserving unchanged files; a failed edit never silently starts
over with an unrelated app.

Failures to save progress are not model mistakes and must not trigger model repair.
Cleanup errors are also separate: the worker must finish or recover cleanup before
moving to another claim. Cancellation requests stop execution explicitly; closing an
event subscription only stops that browser from watching.

## Recover without silently starting over

If the API stops, expired work is checked and cleaned before it is marked interrupted.
It is not automatically sent to the model again. An explicit user retry is needed.
A cancelled build is not reported finished while its resources are still running.

`http` serves safe, currently authorized snapshots and ordered progress events. A
**cursor** tells the server how much progress a reconnecting browser already read.
Activity describes observed operations, not private model reasoning or tool secrets.

## Check a change

```bash
bun test apps/api/src/modules/builds/tests/unit
bun run --cwd apps/api check-types
bun run --cwd apps/api lint
bun run --cwd apps/api build
```

The separate disposable PostgreSQL build-job fixture tests actual saved claims,
concurrent admission, stale writes, cancellation and recovery. Injected generation/
validation adapters do not prove a real provider or Docker image works; those have
separate MCP/sandbox acceptance. Never use instance data for fixture tests.


### Remembering a database choice

For example, a booking-app request can select an existing Development database by its
resource ID and current revision. It never supplies a password, address or SQL. The
shared `BuildDatabaseSelection` validator defines that small value. Admission includes
the explicit choice in the request identity and freezes it in saved job input. Retry
uses the old job's saved choice and refuses a replacement in the request.

New browser choices require a trusted server activation permission. A saved receipt is
still replayable after new admission is disabled. Production startup currently leaves
activation off. Its worker also refuses to execute saved database jobs while inactive,
before inference or validation begins. Explicitly enabled worker composition uses the
existing disposable database validator; stateless jobs retain their original sandbox.
