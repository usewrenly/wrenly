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
