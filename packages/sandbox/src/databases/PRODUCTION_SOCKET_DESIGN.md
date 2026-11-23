# Private Production socket lifecycle

COMPONENT: Production database socket
PURPOSE: Let one isolated app use its own database on the dedicated app server without giving the app IP networking.
INPUTS: Saved project/resource/socket identities, restricted project credentials, pinned private IPv4 endpoint, verified hostname/CA, exact labelled broker network, durable effect fence and target recheck callback.
OUTPUTS: Exact socket container/image/volume identity; no application-ready claim.
STEPS:
1. Verify ownership, durable lease/kernel lock, cancellation and current cluster/DNS identity before resource effects.
2. Verify the dedicated broker bridge belongs to this Production project/resource. Only the trusted broker uses that routed bridge; app/query containers receive the socket volume with network disabled.
3. Build one fixed database mapping with one restricted role. Pin its hostname using Docker ExtraHosts while retaining hostname verification in PgBouncer verify-full.
4. Use the separate CA-aware version 2 toolchain. Deliver credentials and CA over stdin into a private tmpfs, never Docker environment/command fields or persistent host files.
5. Reuse existing independently recorded socket creation intent, acknowledgement, readiness limits and exact cleanup identity.
6. Recheck the upstream after socket startup. A listening socket alone does not establish upstream readiness or authorize a resource-ready write.
EDGE CASES: IPv6-only upstreams are rejected for this initial bridge implementation. A changed certificate, address, ownership or cluster requires review; no TLS fallback.
ERROR STATES: Unknown effects retain caller-owned cleanup/recovery evidence. Do not delete or adopt a matching resource name after an error.

The caller must provide a real target verifier and persist socket effects under its resource claim.
This helper does not create the broker network, admit user actions, publish an app or enable Production UI.
