# Configure the app database server once

An instance owner should not paste the same PostgreSQL server password into every
project. This folder saves and verifies that server connection once. Later project
resources will refer to its exact saved connection ID and receive their own restricted
credentials. Changing the latest connection never changes an existing resource's ID.

`credentials.ts` binds encrypted management credentials to the owner, connection and
target. `store.ts` checks the live owner session, saves a request, claims one verification
and records its result. A claim is temporary permission for one worker to perform that
saved request; its random token and expiry prevent an old worker from completing newer
work. `worker.ts` performs private-address and verified-TLS checks, rejects Wrenly's own
control server and saves the authenticated server identity and pinned addresses.

The key is stored in the separate `production-instance-keys` directory under the
instance data directory. Back it up with the control database. If saved credentials
exist and the original key is missing, restore it; generating a replacement cannot
recover those credentials.

Only the instance owner can configure or inspect this connection. A project owner who
is not the instance owner does not receive management credentials. The setup account
requires administrative authority on the dedicated app-only server; project runtime,
migration and viewer accounts do not receive that authority. The initial runtime
broker supports private IPv4 routing and verified TLS hostnames.

A successful connection check does not create a project database or establish app
readiness. These functions are not mounted as browser routes and the worker is not
started automatically yet. Production remains unavailable until provisioning, backup,
migration, runtime and publishing paths are accepted together. Interrupted read-only
checks require explicit closure before a new reviewed request; no old action is replayed.

The integration tests accept only a separately named loopback fixture database. They
verify encryption, exact request replay, account/session gates, immutable revisions,
expired claims and account-work blockers. They never use an installation database.
