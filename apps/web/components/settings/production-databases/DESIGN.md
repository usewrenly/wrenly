# Connect the application database server

COMPONENT: Owner Production server setup
PURPOSE: Connect a separate PostgreSQL server once so each project can receive its own restricted database.
INPUTS: Current owner view, private hostname, port, maintenance database, management role/password and optional trusted CA.
OUTPUTS: Saved connection check status; credentials are never read back or stored in browser storage.
STEPS:
1. Read current status before enabling the form. A missing route means setup is unavailable, not an empty connection.
2. Validate fields using the shared contract. Generate one request UUID, keep its secret request only in memory, and submit after explicit confirmation.
3. Save only the request UUID in session storage before submission. Never put credentials or connection details in local/session storage, logs, URLs or error messages.
4. Follow the exact request with read-only status polling. On a lost reply, allow status lookup without resubmitting credentials. A new connection is blocked until the existing request is confirmed.
5. On reload, retain the pending UUID and check it before allowing a new request. A missing request does not prove an in-flight submission cannot commit.
6. An interrupted read-only connection check has its own explicit acknowledgement; it never automatically reconnects or creates a project resource.
EDGE CASES: Owner/session authority is rechecked by the API. Replaced connection IDs require a fresh review. Unmount cancels reads; queued server work remains durable.
ERROR STATES: Unknown replies retain the request identity. Unavailable storage blocks submission. Invalid/oversized responses fail closed. No automatic mutation or credential replay.

COMPONENT: Deployment host setup
PURPOSE: Bind the reviewed Coolify server to the private SSH host that owns the generated app containers.
INPUTS: Coolify server ID, private SSH hostname/port/user, verified Ed25519 public host key, OpenSSH private key and explicit confirmation.
OUTPUTS: Credential-free queued/verified/interrupted status and an encrypted instance-local connection.
STEPS: Follow the same read-first, exact-request lookup and lost-response handling above. Validate the shared host contract before submitting. The server verifies pinned private DNS, the SSH host key, fixed helper identity and Coolify placement before acknowledging verification.
EDGE CASES: The public host key must be verified on the destination machine; this form never trusts an unreviewed discovered key. Existing project/deployment bindings retain their immutable connection.
ERROR STATES: Missing helper, foreign server, changed DNS or host key fails closed. Acknowledging an interrupted check only closes that check; it never delivers runtime credentials or repeats publishing.
