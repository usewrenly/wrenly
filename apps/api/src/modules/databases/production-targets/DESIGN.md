# Private Production destinations

COMPONENT: Production database destination policy
PURPOSE: Verify the exact private PostgreSQL destination before a credential-bearing adapter may use it.
INPUTS: Explicit Production host/port/database, trusted control-database URL, bounded DNS resolver and cancellation signal.
OUTPUTS: A validated target with a pinned, sorted private address set, or a safe refusal.
STEPS:

1. Parse a strict shared versioned target contract; require full TLS verification.
2. Resolve every target and control-host address under one bounded deadline.
3. Require every target address to be private unicast; reject metadata, loopback,
   multicast, public addresses and IPv4-mapped bypasses.
4. Refuse any target address shared with the control cluster, even with another
   database name or port. Dedicated application infrastructure is required.
5. Return only non-secret target identity. Later use must recheck the complete saved
   address set and connect to a pinned address while verifying the original TLS hostname.
   EDGE CASES:

- Mixed private/public DNS, changed address sets, empty/oversized answers and cancellation fail closed.
- A matching hostname alone never proves endpoint identity or permission.
  ERROR STATES:
- Invalid configuration or resolution returns fixed text without connection strings or credentials.

This implements the destination portion of the approved Production connection boundary.
It opens no socket, accepts no password, performs no SQL and enables no route or provider.
TLS/authentication, persistent resource admission and publishing are separate gates.

COMPONENT: Credential-free PostgreSQL TLS probe
PURPOSE: Establish verified encryption before a future adapter can send authentication.
INPUTS: Rechecked pinned target, optional explicitly supplied CA and cancellation.
OUTPUTS: Hostname-verified certificate fingerprint, not authentication or resource readiness.
STEPS:

1. Recheck the saved complete DNS set and connect only to its pinned IP/port.
2. Send PostgreSQL's fixed SSLRequest; require exactly the one-byte SSL acceptance.
3. Upgrade with trusted/system CA, full hostname verification and TLS 1.2 minimum.
4. Close every socket on success/failure/abort/deadline; recheck destination before returning.
   EDGE CASES:

- Refused SSL, malformed reply, wrong hostname/CA and timeout never fall back to plaintext.
  ERROR STATES:
- Return one fixed safe error; never authenticate or run SQL during this probe.

COMPONENT: Authenticated private Production inspection
PURPOSE: Verify the PostgreSQL cluster and setup role before saving an attachment review.
INPUTS: Rechecked target, in-memory setup credential/CA, trusted control cluster identity and cancellation.
OUTPUTS: Non-secret cluster/database/role capabilities, never application rows.
STEPS:
1. Use the installed Postgres.js client with a pinned TCP socket factory and verified hostname TLS.
2. Bound the connection, one read-only transaction and total operation; destroy sockets on cancellation.
3. Read fixed PostgreSQL identity/role metadata through Drizzle, including pg_control_system identity.
4. Refuse the control cluster even if it is reached through an unrelated network alias.
5. Require the expected database, primary server and management capabilities; close the pool before return.
EDGE CASES:
- Restricted bootstrap roles or unavailable cluster identity are not treated as verified setup.
- Driver reconnects must repeat destination checks; no mutation or credential fallback is allowed.
ERROR STATES:
- Fixed safe errors; raw driver errors and connection credentials never enter results/logs.
