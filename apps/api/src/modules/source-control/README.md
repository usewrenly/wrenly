# Connecting a project to GitHub

A connection lets a signed-in person choose GitHub repositories that Wrenly may read
or update on their behalf. For example, a developer will import an exact saved app,
edit it in Wrenly, review the changes and push a new branch.

The current implementation is the internal authorization foundation. It does not yet
expose routes or a working browser connection, import or push. Existing Gitea/Coolify
publishing is unaffected.

## Where the code lives

- `github/authorization.ts` creates browser authorization parameters. **State** is a
  random value tying the return from GitHub to the request that started it. **PKCE**
  adds a separate secret so an intercepted authorization code is not enough to exchange it.
- `github/authorization-store.ts` saves the state fingerprint and consumes it once for
  the same live Better Auth session. Only the instance owner may start App registration.
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
source credentials exist. No new environment credential is required by this foundation.

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
