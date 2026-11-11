COMPONENT: Pinned deployment-host command transport
PURPOSE: Send bounded repository-owned helper requests to an explicitly registered private SSH host.
INPUTS: Owner-saved hostname, port, user, complete pinned private IPv4 address set, exact Ed25519 host key and decrypted dedicated SSH private key; bounded request plus abort signal.
OUTPUTS: Bounded validated JSON or fixed failure with no command/credential output.
STEPS:

1. Validate the saved identity, resolve all DNS answers under a deadline and require the exact original private address set.
2. Write dedicated SSH key/known-host files in a fresh mode-0700 directory; these are SSH transport material only, never database credentials or runtime request bytes.
3. Invoke OpenSSH with user configuration, agents, forwarding and local commands disabled; strict host-key checking authenticates the exact pinned address before public-key authentication.
4. Invoke only the installed absolute helper path. The helper request travels through stdin; no model commands, runtime passwords or arbitrary paths enter arguments.
5. Bound stdin/stdout, duration and process lifetime; kill/wait on abort or overflow. Ignore raw stderr, recheck DNS and return only parsed JSON after successful exit.
6. Remove private temporary transport files in finally; never log raw SSH/remote output.
   EDGE CASES: Changed DNS/host keys, unsolicited extra JSON, timeout and partial output fail closed. Existing local transport remains separate.
   ERROR STATES: Caller preserves the original durable operation intent on any unconfirmed transport result; no automatic SSH retry.

COMPONENT: Deployment-host credential binding
PURPOSE: Keep the dedicated SSH key private and prevent moving it to a different owner, host or Coolify server.
INPUTS: Strict owner-confirmed setup input, immutable connection UUID/owner/server/target and a separate instance-local encryption key.
OUTPUTS: Authenticated ciphertext and keyed replay identity; plaintext is available only to an authorized worker.
STEPS:
1. Validate the complete setup input and exact reviewed server/target.
2. Hash the immutable scope into a purpose distinct from PostgreSQL credentials.
3. Encrypt only the SSH private key using existing authenticated encryption.
4. Include every submitted setup field and actor in a keyed request fingerprint.
5. Decrypt only after the caller rechecks the current owner/session and saved work claim.
EDGE CASES: A changed connection, actor, server, target, key or ciphertext fails authentication. Exact submissions retain their request fingerprint.
ERROR STATES: Missing original key or mismatched scope refuses decryption; never create a replacement over saved credentials.
