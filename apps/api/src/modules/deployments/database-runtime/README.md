# Publishing an app that uses a database

A booking app needs more than a running container: its published code must connect
to the Production database whose schema was reviewed. This folder saves that exact
relationship and records each remote setup step before it runs.

For example, creating a socket volume can succeed just before a connection drops.
The pending record stays saved. A normal retry cannot create another volume or
pretend the original failed; recovery must inspect the original resource first.

- `binding.ts` reads the successful saved source, applied migration history, ready
  Production resource and verified deployment host. It returns an immutable snapshot
  for admission to save under the same queue/account/project locks.
- `store.ts` rechecks the live owner session, publishing claim/lease, source identity,
  resource revision/schema and server placement before every effect and acknowledgement.
- The pure `@wrenly/db/production-publishing-contract` defines the ordered steps and
  safe receipts. These contain identities and hashes, never passwords or SSH keys.
- Migration 0046 adds nullable binding/journal fields. Existing stateless deployments
  have neither and retain their existing executor.

These are internal coordinator components. Database-backed publishing remains
unavailable until the executor, recovery, setup/UI and joined acceptance are connected.
A completed broker startup test does not establish public routing or database CRUD.

`executor.ts` runs the bounded ordered sequence under the worker's lock/lease.
It reloads the saved intent before calling an adapter and reloads the acknowledgement
before advancing. A connection loss or cancellation preserves the pending step.
The adapter must still provide the real host/provider proof; an injected unit-test
adapter is not evidence that a public deployment is ready.

`secrets.ts` loads only the selected runtime role, reviewed TLS endpoint/CA and
host SSH material after rechecking the active publishing claim. The management
credential is decrypted locally only to recover its CA; it is excluded from the
returned runtime settings, along with the migrator and reader passwords. Stable
Laravel keys reuse the existing encrypted deployment key rather than being regenerated.

`host-adapter.ts` translates a saved effect into the fixed host helper protocol.
Application discovery matches deployment/project/database labels and then verifies
the exact guardian image and isolation; it never guesses Coolify container names.
`service-adapter.ts` creates and starts only the saved credential-free composition.
Changing server placement or image digests refuses the effect before a provider call.
These adapters do not yet activate the Production executor.

`route-adapter.ts` checks the single configured HTTP relay URL, then independently
checks the broker, app and relay on the deployment host. It probes the public page
and exact deployment marker without forwarding provider or database credentials.
A provider's green status alone never completes publishing. This is route proof;
real application database reads/writes remain a separate acceptance requirement.

`services.ts` composes the durable store and real adapters under the worker's fence.
It reloads claim-bound credentials before each effect. Container discovery and
readiness may be polled for a bounded time; creation, service start and credential
delivery are each invoked once after their durable intent. It remains unmounted
until admission, recovery and joined Production acceptance are complete.
