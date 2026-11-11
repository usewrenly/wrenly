# Connecting to a deployment host

A deployment host is the machine that runs a published app. For example, Wrenly
may run on one machine while Coolify runs generated apps on another. SSH provides
an encrypted connection between them; the saved host key identifies the exact
machine before Wrenly sends a request.

`transport.ts` connects only to the private addresses reviewed during setup. It
ignores user SSH settings and agents, authenticates the saved Ed25519 host key,
and invokes one fixed helper. It never accepts a shell command from the browser
or model. Requests travel on standard input, so future runtime credentials do not
appear in process arguments or Docker configuration.

`helper.ts` reads bounded, versioned requests through the explicit local Docker
socket. Inspection returns the daemon identity. Socket-volume actions derive names
from the saved deployment ID and verify project/resource ownership labels. They
require a matching daemon identity and an exclusive deployment lock. An existing
volume requires explicit inspection rather than an automatic creation retry.
Unknown actions fail before Docker is contacted.
Importing either file starts no connection or process.

Build the standalone helper from `apps/api`:

```bash
bun build src/modules/databases/production-targets/deployment-hosts/helper.ts \
  --target=bun --env=disable --outfile=dist/runtime-host.js
```

This is a verification component, not an enabled production installation path.
Host registration uses a separate encrypted journal in `store.ts`. Only the current
instance owner can submit, read or close its checks. Requests keep their original
values, exact retries return the saved receipt, and expired checks need explicit
review. `worker.ts` requires the deployment adapter to independently match the
inspected Docker daemon to the selected Coolify server before marking a host verified.
The worker is not registered at startup. Runtime bootstrap and database-backed
publishing still need their saved operation checks before invoking the helper’s volume actions. Installing
a helper bundle alone does not enable Production databases.

The unit tests exercise request bounds and private-address checks. The optional
SSH tests start their own temporary SSH server and keys; they do not alter an
operator's SSH service. They prove that a foreign host key, changed DNS answers,
and malformed or excessive replies fail closed.
