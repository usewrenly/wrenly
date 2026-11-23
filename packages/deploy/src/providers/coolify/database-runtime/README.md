# Publishing a database-backed app

A published booking app needs two different connections: browser requests and its
private database connection. `composition.ts` keeps the generated app off IP
networks and gives a separate trusted ingress access to its HTTP Unix socket.
The database broker is managed separately through the verified deployment host.
No runtime password belongs in this Compose document.

`service.ts` creates that document as an inert Coolify service. “Inert” means that
creation does not start the containers. A separate explicit operation starts it;
the executor must still inspect the actual containers and verify the served
revision before reporting publishing success. A queued start is not readiness.

The executor owns saved mutation intent, exact-image provenance, host checks,
credential delivery and recovery. These adapter functions never retry remote
writes. Verification refuses a changed composition instead of adopting another
service by name. The existing stateless image-application adapter remains separate.

The adapter follows Coolify's [service creation](https://coolify.io/docs/api/endpoints/services/create-service),
[service inspection](https://coolify.io/docs/api/endpoints/services/get-service-by-uuid)
and [explicit start](https://coolify.io/docs/api/endpoints/services/start-service-by-uuid)
contracts. Mocked provider tests cover request and receipt boundaries; live joined
publishing acceptance remains necessary before enabling this path.
