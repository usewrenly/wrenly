# Testing saved state without touching your projects

A build admission test sends the same request twice and checks that only one job is
saved. An invitation test creates local accounts and checks who can accept an invite.
These scenarios need a database they are allowed to create and empty, so every suite
has an explicit disposable-database guard.

- `unit/` checks pure credential/URL validation and import boundaries.
- `integration/` exercises real PostgreSQL transactions, migrations and API helpers.
  Its `identity`, `projects`, `execution`, `resources` and `configuration` folders
  match the schema concepts; `connections` checks pool/migration-history behavior.
- `fixtures/` holds small trusted programs used by isolated socket checks.
- `helpers/` holds reusable acceptance scenarios, including real key/kernel checks
  for preview runtime ownership. Their synthetic Docker identities test control-state
  authority; they do not claim that a container or application connection was started.

Run pure checks from the repository root:

```bash
bun test packages/db/tests/unit
```

Integration suites intentionally skip until their own `WRENLY_TEST_*_DATABASE_URL` is
set. They accept only loopback hosts and their exact test database name. Never weaken
that check or point them at the instance database. Review the first lines of the file
for its variable/name pair before running it.

For example, build/conversation suites use `WRENLY_TEST_DATABASE_URL` with
`wrenly_admission_test`, while deployment suites use that same variable with
`wrenly_deployment_test`. Run those groups separately. Likewise project-access and
project-settings suites use different guarded names for `WRENLY_TEST_PROJECT_DATABASE_URL`.
One environment value cannot activate every suite correctly.

A suite may deliberately simulate a failed write, expired lease or lost acknowledgement.
Safe error logs are expected in those tests; the assertions determine whether the
failure was handled correctly. A skipped Docker/browser/worker case is not a passing
acceptance test. Enable those flags separately with their required local toolchains.

Migration-upgrade tests may construct an older schema in their disposable database
before applying later migrations. Do not simplify them into fresh-install-only tests:
existing users need their ownership, history and access boundaries preserved too.
