# Running generated apps safely

You ask Wrenly to build a booking app. The model returns files, but a plausible answer
may still contain broken code. **The sandbox is a separate Docker container where
Wrenly installs dependencies and checks the app.** Generated code never runs directly
inside the API process or on the host as an application.

For one build attempt:

1. Validate file paths, source size and framework requirements before writing files.
2. Create a private temporary workspace belonging to that exact build and worker claim.
3. Install dependencies in a resource-limited container with network access. Bun lifecycle
   hooks stay disabled; Laravel also disables Composer scripts and plugins.
4. Run validation in a separate container with networking disabled.
5. Capture bounded output, remove the containers and then remove their workspace.

A claim identifies the worker execution that owns those resources. Cleanup checks both
build and claim labels so one attempt cannot delete another attempt's containers.
If removal cannot be confirmed, the worker receives a cleanup error requiring recovery.
It must not pretend the attempt stopped safely or launch another repair blindly.

## Finding the code

| Location | Purpose |
| --- | --- |
| `src/index.ts` | Public exports; it does not execute an app on import. |
| `src/builds/build-runner.ts` | Dependency installation, offline build validation and exact-claim cleanup. |
| `src/source-policy/file-paths.ts` | Reject escaping, duplicate and conflicting file paths before host writes. |
| `src/source-policy/nextjs-styling.ts` | Check Tailwind setup by reading text, without executing its config. |
| `src/source-policy/laravel-runtime.ts` | Trusted Laravel commands and source restrictions. |
| `src/previews/` | Preparation, isolated runtime and preview networking. |
| `src/artifacts/` | Package runtime images and remove exactly owned preparation/images; shared by publishing, database validation and previews. |
| `src/databases/` | Internal generated-app database adapters; the product module remains deferred. |
| `images/` | Operator-owned toolchain images, built from repository files. |
| `tests/` | Source-policy, Docker runtime and cleanup acceptance. |

The build runner uses configured memory/CPU limits (defaults: 2 GiB and 2 CPUs), a
256-process limit, dropped Linux capabilities and no-new-privileges. One deadline
(default: five minutes) covers installation and validation. Cancellation retains partial
logs while removing owned containers. A callback that cannot persist execution progress
stops work instead of becoming a model repair.

A successful build is not a running preview or deployment. Preview preparation and
publishing have their own resource identities, authorization and cleanup lifecycles.
Preview and artifact policies are separate from the build runner; passing build
checks alone does not verify those other boundaries.

## Checking the build boundary

From the repository root:

```bash
bun test packages/sandbox/tests/file-paths.test.ts packages/sandbox/tests/unit/nextjs-styling.test.ts packages/sandbox/tests/laravel-source.test.ts
WRENLY_TEST_DOCKER=true bun test packages/sandbox/tests/sandbox.integration.test.ts
bun run --cwd packages/sandbox check-types
bun run --cwd packages/sandbox lint
```

Docker checks use disposable, labelled resources. They execute trusted fixture code
inside containers, including installation-hook, offline-network, cancellation and
cleanup checks. The Bun image must be available locally or initial acquisition needs
internet. Laravel acceptance additionally requires the repository-owned PHP toolchain.
Passing these checks does not certify every generated app or establish the security
of an operator's Docker daemon, host or network.

## How a local preview reaches your browser

After you choose a saved revision, preparation installs dependencies with lifecycle
hooks disabled and validates the app offline. A labelled Docker volume holds those
prepared files. The app runs as a non-root user with a read-only container root and
only its own workspace volume writable.

The app has no published host port and sits on an isolated network. A small trusted
proxy (the ingress) joins that network and exposes only a loopback port. It forwards
to the address verified from Docker's current container and network records. The API
and browser authorization layers control access above this adapter.

In `src/previews`, `runtime.ts` owns preparation and cleanup, `network.ts` defines the
network policy, `target.ts` checks inspected ownership and addresses, and `host.ts`
probes whether the Docker host actually enforces the required isolation. Removing a
preview stops its owned containers before removing networks, volumes and temporary
files. Another preview's resources must remain untouched.

The loopback proxy is not a public deployment. A successful readiness check proves an
HTTP response through that proxy; it does not prove every page or feature works.

## From a validated revision to a published image

An **artifact** is the packaged app that publishing will run. Here it is a Docker
image containing the prepared files, with no host source mount needed at runtime.
`artifacts/runtime-artifact.ts` installs and compiles the selected source in its own
labelled volume, then uses trusted copy commands to assemble that image. Laravel's
validation environment files/config caches are removed before the runtime image is
committed. Real application secrets are supplied later by the deployment system.

`artifacts/artifact-watchdog.ts` provides a trusted container guardian that ends
hung generated commands even if the API disappears. `artifact-policy.ts` identifies
the workspace-isolation format required before promotion; older images cannot simply
be relabelled to skip rebuilding.

`artifacts/artifact-registry.ts` uploads only an owned image to a private registry.
A **digest** is a content hash identifying exact image bytes. The adapter reads the
published manifest, checks its hash and local image identity, and verifies anonymous
requests remain denied. Publishing uses that digest rather than trusting a movable tag.
Cleanup removes preparation containers before volumes; retained runtime images have a
separate explicit lifecycle so cleanup does not stop an already deployed app.

Docker acceptance is in `tests/runtime-artifact.integration.test.ts` and
`tests/artifact-registry.integration.test.ts`. The former needs `WRENLY_TEST_DOCKER=true`;
the latter needs `WRENLY_TEST_ARTIFACT_REGISTRY=true` and a local `registry:3` image.
The registry test creates its own loopback registry and fake credentials. It does not
use your configured publishing registry or contact Coolify.

## Internal application-database adapters

The `src/databases/README.md` guide explains role-scoped Unix sockets and durable
operation intent with a booking-app example. These adapters remain internal: the
product database worker, routes and viewer stay disabled. Their tests check isolated
building blocks, not a complete database-backed generated app.
