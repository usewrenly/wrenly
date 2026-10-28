# Remembering and carrying out publishing requests

Clicking **Publish** starts server-owned work. This module checks who may publish,
saves the selected app version and follows the operation through to a verified result.
The browser can close or refresh without becoming responsible for the work.

For example:

> Publish a saved version → refresh the browser → Wrenly continues the saved request →
> reopening the project shows its progress and final result.

The deployment library talks to Gitea/Coolify. This API module decides when those calls
are authorized and how their results are remembered.

## Find the code

```text
http/          Reads requests and returns safe publishing status/history
persistence/   Saves requests, worker ownership and provider confirmations
execution/     Runs queued work and checks the published app
recovery/      Local operator command for checking interrupted operations
policy/        Validates the saved source and its content fingerprint
tests/unit/    HTTP and source rules
tests/browser/ Publishing and Connections interfaces with controlled replies
```

## Understand the saved-work terms

A **durable request** is saved in PostgreSQL before the API acknowledges it. It survives
a browser refresh. A **worker** is the server loop that picks up saved requests.

The worker takes a **claim**, a unique token identifying who may update that operation.
A **lease** gives the claim an expiry time; the worker renews it while running. An old
worker cannot keep writing after losing ownership. A kernel lock also prevents two
local processes from carrying out the same operation together.

Before a provider-changing call, Wrenly records its **intent**—what it is about to do.
After receiving and checking the reply, it records the **acknowledgement**. If the reply
is lost, the operation stays uncertain. The provider may already have changed something.

Checking that uncertain result is **reconciliation**. It must not silently repeat the
provider call. Even after local work stops, a remote deployment may still be running.

## Authority and safe responses

Only the project owner may publish a successful saved version. Instance administration
alone grants no access to private projects. Archived projects reject new publishing.
Status/history reads use current project-read permissions and include readable archives.

HTTP replies never include source snapshots, tokens, claim identifiers or saved private
provider operations. They use `no-store`, telling browsers and caches not to retain the
response. Shared claim/target types come from the store; provider types come from the
deployment library. Do not duplicate those contracts in handlers.

## Check a change

```bash
bun test apps/api/src/modules/deployments/tests/unit
bun run --cwd apps/api check-types
bun run --cwd apps/api lint
bun run --cwd apps/api build
```

Database fixtures in `packages/db/tests/integration/resources/deployment-*.integration.test.ts` check real
saved-state changes in disposable databases. Browser fixtures use controlled replies.
Neither substitutes for verifying a real published app.

From `apps/api`, the operator reconciliation command is:

```bash
bun src/modules/deployments/recovery/reconcile-deployment.ts DEPLOYMENT_UUID --confirm-remote-settled
```

Run it only after checking the exact remote operation. It changes saved recovery state;
it is not a harmless way to dismiss a blocked status message. See the public publishing
operations guide for the full procedure.
