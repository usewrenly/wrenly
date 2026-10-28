# Database-backed preview startup

COMPONENT: Prepared database preview runtime
PURPOSE: Run one saved image against its runtime-role socket behind the existing trusted ingress.
INPUTS: Exact preview/image/socket identities, runtime role, stable Laravel key, trusted bundles and caller fence.
OUTPUTS: Owned app/ingress resources and loopback ingress URL after authenticated HTTP readiness.
STEPS:
1. Validate bounded inputs and inspect the exact prepared image and scoped socket/volume.
2. Create the same private per-preview workspace and isolated application network used by stateless previews.
3. Start trusted PID1 from a read-only bootstrap bundle; send role/key only through local Docker attach stdin.
4. Drop generated execution to UID1000 under a root guardian with a fixed lifetime; suppress generated stdout/stderr.
5. Start repository-owned ingress, dual-homed to the app's isolated network and loopback publishing network.
6. Save exact runtime resources through the caller, verify bounded authenticated HTTP readiness, then return.
EDGE CASES:
- No source rebuild, credentials during preparation, Docker Env/Cmd secrets or automatic application restart.
- Every mutation rechecks caller authority; lost/unknown effects retain labelled resources for independent cleanup.
- Application cleanup reuses the original preview remover and does not remove the database/socket/image.
ERROR STATES:
- Any invalid ownership, early exit, cancellation or readiness timeout returns a fixed safe error.
- Cleanup remains an independent journalled operation; startup never claims cleanup or releases capacity.

Acceptance uses separate tiny Next.js-driver and PHP fixtures against a real scoped
PostgreSQL socket, then passes HTTP through the actual ingress bundle. It checks
unprivileged generated execution, blocked IP egress, secret-free Docker configuration,
capability refusal and cleanup after a lost fence leaves a partial network. It does
not replace full generated-framework or production worker/recovery acceptance.
