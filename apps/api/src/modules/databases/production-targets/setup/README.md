# Saving a Production database connection

This folder remembers the connection a project owner has explicitly confirmed.
For example, an owner enters a private PostgreSQL address and setup credentials.
Wrenly saves an encrypted request before a worker checks that connection, so a
lost browser response does not create another request.

A successful connection check is **not** a ready application database. Creating
roles, applying migrations and publishing an app require separate confirmed work.
This module provides storage functions and a single-request verification worker.
It does not activate HTTP routes or register that worker at API startup.

- `credentials.ts` validates bounded input and encrypts credentials. Encryption
  binds the project, owner, access revision and destination together, so moving
  encrypted data to another request makes decryption fail.
- `setup-store.ts` checks current sessions and ownership, saves requests, hands
  each request to one worker, and records safe connection-check results.
- The unit and PostgreSQL integration tests check encryption, repeated requests,
  expired worker claims, and revoked or unrelated accounts.

A claim is temporary permission for one worker to process one saved request.
Expired claims become `needs_review`; they do not restart automatically. Reading
a receipt only reads the saved result and never contacts the remote database.
Browser receipts contain no passwords, certificates or encrypted credentials.

Setup keys live in `production-setup-keys` under the instance data directory.
Back up that directory with the control database. If encrypted requests exist
and the key is missing, restore the original key; a replacement cannot recover
those requests.

Integration tests require an explicitly supplied loopback PostgreSQL URL whose
database name is `wrenly_production_setup_test`. They create schema and clear
setup records in that disposable database; never use an installation database.

`verification-executor.ts` sequences one claimed check and keeps remote failures
separate from an unconfirmed result save. `verification-worker.ts` connects it to
the encrypted store and the private TLS inspector. It obtains the control cluster
identity directly from PostgreSQL; browser input cannot supply or override it.
The control database role must be allowed to read `pg_control_system()`; a denied
identity read refuses verification rather than weakening cluster separation.

`http.ts` provides authenticated submit, receipt lookup and interrupted-check
acknowledgement handlers. It checks the instance origin for writes, bounds actual
streamed bytes and returns only a validated receipt after rechecking the session.
Constructing these handlers does not register routes. They remain unmounted until
the complete provisioning flow is available.

The owner may explicitly close an interrupted read-only check after its worker lease
expires. This preserves the original request as failed; it does not repeat the
connection check or apply SQL. A new attempt requires a new confirmed request.
A live worker cannot be displaced, and a stale worker cannot complete a closed request.
