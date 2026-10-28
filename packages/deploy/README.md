# Putting a generated app online

**Publishing means taking a validated version of an app and making it available at a
live address.** This package talks to the services used for that step.

For example:

> You choose a saved version and click Publish → Wrenly prepares that exact app →
> Coolify runs it → Wrenly checks that the live address serves the expected version.

The API checks permissions, saves the publishing request and coordinates the steps.
This library contains the **adapters**: code that translates Wrenly's requests into
Gitea and Coolify API calls. The sandbox package builds the app inside Docker.

## Find the code

```text
src/
  providers/gitea/           Creates and checks private source repositories
  providers/coolify/         Configures the running app and checks deployment status
  source-snapshots/          Uses Git to commit and push generated source
  http/                     Sends limited, authenticated provider requests
  secrets/                  Encrypts secrets and checks runtime settings
  index.ts                  Exports shared connection functions and types
tests/unit/                 Checks rules with controlled replies
tests/integration/          Uses local fake HTTP/Git services
```

Gitea creates the repository; Git puts commits into it. Those are different operations,
which explains `providers/gitea` versus `source-snapshots`. Other hosts may reuse Git
transport, but GitHub/GitLab adapters are not implemented yet.

## Publish the app that was checked

A Docker **image** is the packaged app ready to run. A private **registry** stores it.
Its **digest** is a content fingerprint that identifies the exact image.

```text
API saves the authorized request
  → Git retains a private source copy
  → sandbox builds the app image
  → private registry stores the image
  → Coolify runs the exact image
  → Wrenly checks the live app's version
```

The executor that coordinates these steps lives in `apps/api/src/modules/deployments`.
Secrets needed by the running app are delivered separately. They do not belong in Git
or image build arguments. The removed source-rebuild/direct-deploy paths must not return.

## A missing reply does not mean nothing happened

Suppose Coolify starts an app but its reply never reaches Wrenly. Sending the same
instruction again could start another operation. The API saves what it was about to do
and what the provider confirmed. An uncertain result stays blocked for explicit checking.
That checking is called **reconciliation**. Adapters must not automatically retry writes.

HTTP requests use one configured destination, reject redirects, limit response size
and stop on cancellation/deadline. Secret encryption is tied to its project and purpose.
Failures must not log provider bodies, tokens or private keys. The API owns contextual
logging and recovery; this library does not decide who may publish.

## Check a change

From the repository root:

```bash
bun test packages/deploy/tests/unit
bun run --cwd packages/deploy check-types
WRENLY_TEST_DEPLOY_HTTP=true bun test packages/deploy/tests/integration
```

Local integration checks need Git, GNU timeout and local sockets. They use temporary
repositories and fake credentials; they do not verify your real publishing services.
