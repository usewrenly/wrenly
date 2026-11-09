# Checking where a Production database would connect

Before Wrenly sends a database password, it must check the destination. For example,
a booking app's Production database must not accidentally point at the PostgreSQL
server that holds Wrenly accounts and projects.

This folder contains the first connection checks. It does not yet attach a resource,
store credentials, expose a dashboard action or enable database-backed publishing.

- `target-policy.ts` accepts a strict host/port/database description, requires a TLS
  hostname and `verify-full`, and resolves every address. Only private unicast addresses
  are eligible. Any address shared with the configured control endpoint is rejected,
  regardless of database name or port. Mixed unsafe DNS answers are rejected too.
- A **pinned address set** is the exact list saved for review. Rechecking may reorder
  equivalent answers but cannot silently accept added, removed or changed addresses.
  The later connection must use one of those addresses while verifying the original
  hostname. This check alone cannot identify clusters behind different network aliases;
  authenticated cluster/resource identity remains a later attachment gate.
- `tls-probe.ts` connects to a rechecked pinned address and sends only PostgreSQL's
  fixed request to start encryption. It requires certificate-chain and hostname
  verification, closes the socket, then checks the destination again. It sends no
  username, database name, password or SQL. A certificate fingerprint is evidence of
  that probe, not permission to skip TLS checks on a later connection.

The non-secret target contract lives in the pure
`@wrenly/db/production-database-target-contract` subpath. Passwords and CA storage
must use the reviewed credential/resource boundary, not this metadata contract.
System CA trust is the default; an explicitly reviewed CA may be supplied in memory.
There is no plaintext fallback or disabled certificate verification mode.

Tests exercise private-address policy and real local TLS negotiation. The TLS fixture
runs on Node 24+ to independently check the Bun client; OpenSSL creates its temporary
certificate. Fixture files and sockets are removed afterward. These tests do not prove
an actual PostgreSQL account can authenticate, has safe privileges or can be published.

Protocol references: [PostgreSQL SSL negotiation](https://www.postgresql.org/docs/17/protocol-flow.html#PROTOCOL-FLOW-SSL)
and [TLS certificate verification](https://nodejs.org/docs/latest-v24.x/api/tls.html#tlsconnectoptions-callback).
