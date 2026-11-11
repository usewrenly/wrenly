# Serving an app without granting it network access

For example, a published booking app needs to receive browser requests and save
bookings. That does not require allowing its generated code to connect to arbitrary
internet addresses. Database traffic uses its separate protected database socket.
This folder provides the HTTP path only:

```text
Browser → trusted ingress → shared Unix socket → app's loopback HTTP server
                          generated container: IP networking disabled
```

A Unix socket is a local communication endpoint represented by a file. The trusted
application guardian owns that socket. The generated child cannot replace the
root-owned socket directory. The ingress can connect to the socket through a
read-only volume mount; it receives no database credentials or Docker socket.

`relay.ts` limits simultaneous connections, respects stream backpressure and closes
both peers on timeout or shutdown. `application-http.ts` supplies the fixed offline
app destination. `ingress.ts` supplies the fixed network-facing listener and Unix
upstream. These files do not select apps, mount volumes, start generated processes
or authorize deployments; the publishing executor owns those decisions.

Build the trusted ingress image from the repository root:

```bash
docker build -t wrenly/deployment-ingress:1 \
  -f packages/sandbox/images/deployment-ingress/Dockerfile packages/sandbox
```

The image is an internal prerequisite, not a standalone app. Publishing must pin
its inspected image identity and the deployment-owned socket volume. An ingress
image existing locally does not enable database-backed publishing.
