# Publishing an app that uses a Production database

A booking app needs two connections when published: visitors must reach its web
server, and the app must reach only its own database. This folder connects those
paths without giving generated code general network access or putting passwords
in Git, Compose or Docker configuration.

For example:

> Publish the reviewed booking revision → save each infrastructure action → start
> the trusted database socket and isolated app → verify the exact app through its
> public route → record success.

The generated app has no IP network. A trusted database broker supplies its runtime
role through a Unix socket. A separate HTTP relay lets visitors reach the app; that
relay has no database credentials. The trusted guardian starts the generated process
as user 1000 after a single verified settings handoff.

## Find the responsibilities

| File | Responsibility |
| --- | --- |
| `binding.ts` | Freeze the successful source, applied schema, owner and selected host |
| `store.ts` | Save ordered effects and recheck ownership, resource, host and lease |
| `secrets.ts` | Select the runtime-only credentials inside the API |
| `executor.ts`, `services.ts` | Carry out one saved effect at a time |
| `host-adapter.ts` | Call the fixed host helper for owned socket resources and guardian startup |
| `service-adapter.ts` | Create/start the fixed Coolify composition without database credentials |
| `route-adapter.ts` | Independently verify host containers, service composition and served revision |
| `publishing.ts` | Join artifact preparation and private image promotion to runtime execution |

A saved **effect** is an action recorded before changing remote infrastructure.
Its **receipt** is the independently checked result. If the reply is lost, the effect
remains unresolved. The next worker cannot simply repeat it.

## Saved identity and credentials

Admission saves the binding and empty runtime journal atomically under the existing
queue/account/project locks. Every effect rechecks the original owner's live session,
source identity, applied migration set, resource revision and verified host placement.
Migration 0046 supplies the nullable binding/journal fields; stateless publications
retain neither field and keep their separate executor. The pure
`@wrenly/db/production-publishing-contract` owns the shared receipt contract.

The executor selects this path from the saved binding, never from the current prompt.
It requires the Production adapter before any Git or registry effect and prepares the
artifact with the exact migration digest. Completion requires the verified route;
a stateless Coolify job ID cannot substitute for these receipts.

`secrets.ts` returns only the runtime role, reviewed TLS endpoint/CA and host SSH
material. Management credentials are decrypted locally only to recover the CA;
management, migration and reader passwords never enter the returned runtime settings.
Laravel reuses its existing encrypted application key instead of generating a new one.

## Read-only route recovery

`../recovery/reconcile-production-route.ts` handles only an interrupted final route
check. It takes the existing kernel lock and a fresh verification lease, rechecks the
original owner's current authority and preserves the seven completed runtime receipts.
Successful proof acknowledges the original route intent and completes the original
publication. If completion itself lost its acknowledgement, a new read-only check can
settle it without adding another runtime action.

Unknown earlier changes, stale access, changed resources or another active publication
remain blocked. This command cannot recreate a service, deliver credentials again or
repeat application SQL. See the public publishing-operations guide for exact commands.

## Native framework acceptance

The opt-in test uses actual Next.js and Laravel source, not a simulated framework
server. It creates its own private TLS PostgreSQL fixture, a separate database/runtime
role, owned socket volumes, trusted broker and real guardian image. The generated app
stays network-isolated while it creates, reads and updates records. An explicitly
verified app restart must preserve those records; a second credential delivery to an
already-ready app must fail.

Build the trusted toolchains first, using the installation guides:

```bash
docker pull postgres:17-alpine
docker pull oven/bun:alpine
docker build -t wrenly/database-socket:2 packages/sandbox/images/database-socket
docker build -t wrenly/laravel-runtime:13-php8.4 packages/sandbox/images/laravel
```

From the repository root:

```bash
WRENLY_DATABASE_URL=postgresql://fixture:fixture-only@127.0.0.1:1/fixture \
WRENLY_TEST_PRODUCTION_FRAMEWORK_RUNTIME=true \
bun --no-env-file test apps/api/src/modules/deployments/database-runtime/framework-runtime.integration.test.ts
```

The placeholder control URL is validated but never contacted by this test. Actual app
data lives only in its disposable PostgreSQL container. OpenSSL and local Docker are
required; source installation needs initial package-network access, then compilation
and generated runtime keep their existing isolation.

This proves the framework/socket/guardian and explicit app-restart path. It does not
establish real Coolify routing, automatic host-reboot recovery or safe replay of an
unknown earlier infrastructure mutation. Those require their own joined acceptance.


## Recovering interrupted runtime steps

`../recovery/reconcile-production-setup.ts` checks a lost acknowledgement for any
of the seven setup/start stages. `setup-inspection.ts` handles owned socket storage
and an empty network; `start-inspection.ts` proves broker readiness, pinned service
placement/composition, running app/relay or root guardian readiness as appropriate.
`inspection-configuration.ts` reconstructs expected artifact and installation settings.
Only host credentials and non-secret upstream metadata are selected for these checks.

A same-name container is insufficient. Broker discovery requires all ownership labels
and a full independent isolation check. A running app is insufficient to acknowledge
settings delivery: the trusted root guardian must have recorded readiness in its
protected state directory. None of these inspections creates, starts or sends settings.

The publication stays interrupted after its original receipt is saved. The separate
`../recovery/continue-production-publication.ts` command requires explicit confirmation,
rejects pending effects, rechecks completed resources through `inspect-completed.ts`
and runs the existing coordinator only for never-started steps. Prior publishing
receipts remain unchanged. Final success still requires independent public-route proof.
The public publishing-operations guide gives the commands and prerequisites.
