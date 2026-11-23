# Connecting a project to GitHub

A connection lets a signed-in person choose GitHub repositories that Wrenly may read
or update on their behalf. For example, a developer will import an exact saved app,
edit it in Wrenly, review the changes and push a new branch.

The browser connection supports instance App registration, personal authorization,
repository-access checks and disconnect. Project import and reviewed new-branch pushes are connected. Existing Gitea/Coolify publishing is unaffected.

## Where the code lives

- `github/authorization.ts` creates browser authorization parameters. **State** is a
  random value tying the return from GitHub to the request that started it. **PKCE**
  adds a separate secret so an intercepted authorization code is not enough to exchange it.
- `github/authorization-store.ts` saves the state fingerprint and consumes it once for
  the same live Better Auth session. Only the instance owner may start App registration.
- `github/http.ts` authenticates requests and returns callbacks to Connections without codes.
- `github/exchange.ts` bounds credential exchanges to GitHub, without automatic retries.
- `github/connection-store.ts` completes connections and invalidates pending callbacks on disconnect.
- `github/service.ts` coordinates account setup and bounded repository discovery.
- `github/credentials.ts` encrypts source credentials with a separate instance-local key.
  It reuses the existing provider-envelope primitive, not the model configuration service.
  Envelopes are bound to purpose, local user and connection version; swapping them fails.
- `packages/source-control` holds reusable file policies and GitHub response decoding.

Migration `0036` adds App registration, personal connections and authorization requests.
It is generated but not applied automatically. No external GitHub request is made by
these storage functions. Once an authorization callback is consumed, an uncertain code
exchange must start a fresh authorization; it cannot replay the old callback.

The private `source-control/provider-key` under the configured instance data directory
must be backed up with PostgreSQL. Missing keys cannot be regenerated while encrypted
source credentials exist. No GitHub credential needs to be copied into an environment file.

## Verification

Unit tests check origin/PKCE parameters and cross-account credential substitution.
The guarded database suite checks single-use callbacks, concurrent consumption,
owner-only registration, revocation, expiry and stale App versions:

```bash
bun test apps/api/src/modules/source-control/github/tests
```

For database acceptance, supply `WRENLY_TEST_SOURCE_DATABASE_URL` pointing only to a
disposable local database named `wrenly_source_test`, then run
`packages/db/tests/integration/configuration/source-authorization.integration.test.ts`.
That suite migrates and clears its fixture tables. Never point it at an installation.

## Import confirmation storage

An import review saves the exact server-fetched commit for ten minutes. Confirming it
creates a private project, its source revision and one validation job in the same
PostgreSQL transaction. A lost response can replay the same request UUID to recover
that project's acknowledgement. It cannot create a second project from the same review.
Migration `0037` adds these review and origin records. They preserve the imported
baseline for later source-change review; they contain no GitHub tokens.

The current internal admission functions live in `imports/import-store.ts`. They
recheck the active local session, personal connection and instance App version.
The Home and Projects import interface uses authenticated review/confirmation endpoints.
`imports/import-reader.ts` assesses root framework compatibility without running code;
`imports/import-service.ts` binds the read to the current personal connection.
The source push worker starts with the API and stops with its lifecycle.


## Reviewed pushes

For example: select a saved booking-app revision → review its changes against the
pinned GitHub baseline → confirm a new `wrenly/` branch. A chat never pushes by itself.

`pushes/push-store.ts` handles owner access, saved reviews, exactly replayable admission
and worker claims. `pushes/push-worker.ts` commits each phase intent before creating a
Git tree, commit and new ref. It checks current session/project/connection authority
before each mutation. Account/project row locks fence each bounded remote call against
concurrent revocation; calls can briefly delay changes to that same account/project.

A missing receipt remains `needs_review`. `pushes/push-recovery.ts` checks the exact
saved repository, branch, parent and tree without any remote POST. Expired worker leases
never requeue remote writes. Queued work can be stopped by changed access; an already
sent remote request cannot be retroactively recalled. No ref-update method exists.

Migration `0038` adds push review/operation records. Credentials never enter those
records, build inputs or Git commits. `github/refresh.ts` persists a one-use refresh
intent before exchanging an expiring token. Lost refresh replies require browser
reauthorization; they never cause reuse of the same refresh token.

Tests use controlled GitHub replies and a disposable PostgreSQL database. They prove
local authorization, persistence, replay and recovery, not real GitHub acceptance.
