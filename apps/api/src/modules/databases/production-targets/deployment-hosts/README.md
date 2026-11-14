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

The opt-in Production activation registers this verification component.
Host registration uses a separate encrypted journal in `store.ts`. Only the current
instance owner can submit, read or close its checks. Requests keep their original
values, exact retries return the saved receipt, and expired checks need explicit
review. `worker.ts` requires the deployment adapter to independently match the
inspected Docker daemon to the selected Coolify server before marking a host verified.
The worker starts only with the separately enabled Production module. Runtime bootstrap and database-backed
publishing still need their saved operation checks before invoking the helper’s volume actions. Installing
a helper bundle alone does not enable Production databases.

The unit tests exercise request bounds and private-address checks. The optional
SSH tests start their own temporary SSH server and keys; they do not alter an
operator's SSH service. They prove that a foreign host key, changed DNS answers,
and malformed or excessive replies fail closed.

`network.ts` creates an empty deployment-labelled bridge for the trusted database
broker. It rejects existing networks during creation and rejects custom options
or attached containers during inspection. This does not give the generated app
network access: the app uses only its authenticated Unix socket. Publishing must
save the returned daemon/network identity before it can deliver a runtime role.

`application-inspection.ts` checks the actual container rather than trusting a
provider status. For example, a correct image with an added environment password,
network connection or writable database mount is rejected. The reply contains
only the expected image/container IDs and whether it is running. Inspection itself
does not start the app or deliver credentials.

`broker.ts` gives a published app its runtime database connection. Only the trusted
broker joins the private network; the generated app reaches its authenticated Unix
socket. The password arrives on stdin and its configuration is held in container
memory-backed storage. Docker environment/command fields and host files never hold
it. `broker-inspection.ts` checks an interrupted broker without sending another
password or restarting it. A healthy socket is one step: the complete publishing
flow must still prove the expected database and real application reads/writes.

The API build now includes `dist/runtime-host.js`. Installing that helper is part
of deployment-host setup; installing it alone does not enable database-backed publishing.

`application-start.ts` starts the saved app guardian after checking its broker and
container. It sends only the runtime role and framework startup settings. A second
request to an already-running app is refused. The guardian starts the generated
process as user 1000 and emits its own readiness marker. This proves local startup,
not the public URL or a successful database transaction.

`ingress-inspection.ts` verifies the HTTP relay separately from the generated app.
For example, a relay with a database volume, added password environment variable,
root user or host networking is rejected even if Coolify calls it healthy. Discovery
requires one exact labelled container and independently checks its image, owned
read-only HTTP volume and bridge networks. It never starts a stopped relay.


`runtime-stop.ts` handles the current owner's explicit Stop. Under the same host
lock, it verifies the original immutable application/broker IDs and full isolation
policy, stops them with a bounded grace period and inspects them again. It deletes
nothing and sends no database password. Its caller must first durably pause
maintenance and save the Stop intent; inspecting this helper's result cannot grant
restart permission. Install the matching current `runtime-host.js` bundle before
using these commands. An older helper rejects unknown actions rather than falling
back to a shell command.

Coolify adds a fixed set of service metadata to deployed containers.
`runtime-environment.ts` checks those fields separately: image settings must remain
unchanged, service identifiers must match the selected deployment, and unknown
environment additions still fail. This allows provider bookkeeping without allowing
a database password, `NODE_OPTIONS`, or another runtime override through inspection.
