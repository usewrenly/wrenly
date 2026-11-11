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
