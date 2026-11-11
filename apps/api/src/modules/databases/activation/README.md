# Starting the Production database services

A generated booking app can use one database while being developed and a different
one when published. This folder connects the Production setup screens, saved work
and publishing executor to API startup. It does not create an external server just
because Wrenly starts.

The feature remains off by default. `WRENLY_PRODUCTION_DATABASES_ENABLED=true` requires
Development databases, previews and private publishing to be configured. The module
checks the repository-built broker and HTTP relay images against their exact installed
IDs before starting workers. A missing prerequisite stops startup; it does not leave
part of the module running behind apparently available controls.

`production-activation.ts` returns the protected handlers, publishing adapters and one
cleanup function. API startup mounts those handlers only after startup succeeds.
Shutdown awaits both the control worker and resource worker. The control worker
progresses explicitly saved requests; it never invents a setup request or repeats an
unknown remote mutation.

## Prepare the trusted images once

From the repository root, build the toolchains already used by Development and the
credential-free HTTP relay needed by Production publishing:

```bash
docker build -t wrenly/postgres-runtime:17 packages/sandbox/images/postgres
docker build -t wrenly/database-socket:1 packages/sandbox/images/database-socket
docker build -t wrenly/deployment-ingress:1 packages/sandbox/images/deployment-ingress
bun run --filter @wrenly/api build
```

Configure the private registry using the public publishing setup guide, then run:

```bash
bun run prepare-production-images --confirm-private-upload
```

The command reads the repository-root `.env`, verifies the fixed toolchains and
uploads only the trusted HTTP relay. It prints three non-secret settings: the local
broker image ID, local relay image ID and verified private relay registry reference.
Copy those lines into the root `.env`. It never enables Production itself, writes
credentials into source or opens the control database. Without the confirmation flag
it prints usage and performs no upload.

The deployment server must also have the exact broker image and built host helper
installed. Its registry access must permit pulling the private relay and app images.
These requirements are separate from successfully uploading an image locally.

## Acceptance boundaries

The activation tests cover disabled behavior, failed verification, protected handlers,
service composition and awaited shutdown. Disposable private-registry acceptance
verifies both application and trusted relay promotion, exact content identity and
anonymous access denial. A built-API smoke check must also prove startup and shutdown
against a fresh disposable control database. None of these checks alone proves a
published app can save real data through Coolify or recover from a remote restart.
