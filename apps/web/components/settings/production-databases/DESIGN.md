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
