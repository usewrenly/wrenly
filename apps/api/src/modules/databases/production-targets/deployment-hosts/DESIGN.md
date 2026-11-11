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

COMPONENT: Durable host registration and verification
PURPOSE: Preserve exactly what the owner approved and distinguish verified, refused and interrupted checks.
INPUTS: Current instance owner/session, expected prior connection, request ID, reviewed host/server and dedicated SSH key.
OUTPUTS: Private receipt and pinned verified machine facts; no secret appears in a status response.
STEPS:
1. Lock shared work queues and recheck the active instance owner before touching encryption storage.
2. Return exact request replay; reject changed requests and stale prior revisions.
3. Block changes while database or publishing work needs completion or recovery.
4. Save immutable input and encrypted SSH key, then claim a queued check with a bounded lease.
5. Recheck claim/session before decryption; pin private DNS, authenticate SSH and inspect the fixed helper.
6. Require the deployment adapter to independently verify the reviewed server/machine match.
7. Persist verified facts only while the original claim and owner session remain current.
EDGE CASES: Expired checks become review-required, never automatically retried. Closing an interrupted read-only check requires an explicit owner action. Account changes remain fenced while work is unresolved.
ERROR STATES: Unknown completion remains saved for review; a status read does not decrypt secrets or start remote work. Registration does not activate publishing.

COMPONENT: Host setup HTTP and Coolify placement check
PURPOSE: Let authenticated setup submit/read/acknowledge a saved request without exposing keys or triggering work from a status read.
INPUTS: Trusted-origin bounded JSON, current session, exact request UUID and configured deployment-provider client.
OUTPUTS: Strict private/no-store receipts and safe verified host facts.
STEPS:
1. Validate method, origin, body bounds and session before store access.
2. Recheck the same session after the store call; malformed service outputs fail without being returned.
3. Keep routes optional until production composition supplies their services.
4. Read only the configured Coolify server UUID using the bounded provider client.
5. Require its SSH port and hostname/selected private IP to match the owner-reviewed SSH destination, and recheck the complete DNS set.
EDGE CASES: Foreign placement, changed DNS, session rotation and lost acknowledgements never silently resubmit.
ERROR STATES: Provider/credential bodies are never browser responses; failed verification does not enable publishing.

COMPONENT: Deployment-owned socket volumes
PURPOSE: Prepare empty HTTP/database socket storage on the verified deployment daemon without accepting arbitrary mounts.
INPUTS: Versioned action, nonce, expected daemon ID, deployment/project/resource IDs and saved claim identity.
OUTPUTS: Exact volume names and creation timestamps, or an unconfirmed result requiring inspection.
STEPS:
1. Validate the request and daemon before acquiring the dedicated per-deployment kernel lock.
2. Derive names from the deployment UUID; never accept a path or volume name.
3. Inspect local-driver volumes and every project/resource ownership label.
4. Refuse creation when a volume exists; use the separate inspection action for uncertain creation.
5. Create only the requested empty socket volume, inspect it, and return a nonce-bound reply.
6. Release the lock after every outcome; never delete resources on uncertainty.
EDGE CASES: Same-host API and helper locks have separate namespaces. Foreign volumes, daemon changes and active helpers refuse progress.
ERROR STATES: The publishing caller retains durable intent until verified acknowledgement or explicit reconciliation; transport failures never retry creation.
