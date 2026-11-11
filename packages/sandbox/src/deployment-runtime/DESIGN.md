COMPONENT: Fixed application HTTP socket bridge
PURPOSE: Carry application HTTP between a network-disabled generated container and a trusted ingress container without granting the app IP egress.
INPUTS: Repository-owned fixed transport endpoints and cancellation; no generated command, destination or credential.
OUTPUTS: Bounded bidirectional byte streams and awaited connection cleanup.
STEPS:

1. Application-side transport listens on a deployment-owned Unix socket and connects only to loopback port 3000 inside that container.
2. Ingress transport listens on its fixed TCP port and connects only to the mounted application socket.
3. Limit simultaneous streams, apply idle timeouts and let stream backpressure bound buffering.
4. Destroy both ends on errors, disconnect or shutdown; close the listener and await cleanup.
   EDGE CASES: Slow peers, app startup races, overload and shutdown fail by closing streams; no fallback destination or automatic remote mutation.
   ERROR STATES: Never return internal errors or credentials in HTTP bodies. These helpers do not grant database access or start the application.

COMPONENT: Production application guardian
PURPOSE: Start the exact prepared app with runtime-only database settings delivered through stdin.
INPUTS: Bounded versioned framework/resource/runtime-role/stable-Laravel-key input; verified image and socket volumes supplied by publishing.
OUTPUTS: Fixed readiness marker and running offline app; no plaintext Docker Env or host credential file.
STEPS:
1. Require privileged PID1 inside the trusted runtime image and bound stdin to five seconds/eight KiB.
2. Validate exact fields and runtime role ownership before spawning any generated process.
3. Prepare only fixed Laravel temporary directories, then start the app as UID/GID1000 with process-local settings.
4. Start the guardian-owned Unix HTTP bridge; probe localhost under a bounded startup deadline.
5. Forward shutdown, await the child and close all bridge connections; never restart the child automatically.
EDGE CASES: Invalid input, missing stable key, early child exit or readiness timeout stops the container. A container restart without a new authorized credential delivery fails closed.
ERROR STATES: Only fixed diagnostics and readiness markers leave the guardian; no raw credential or application error is returned.
