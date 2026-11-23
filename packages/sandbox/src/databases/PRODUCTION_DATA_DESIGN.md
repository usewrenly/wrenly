# Data helpers for a remote project database

COMPONENT: Production socket data helpers
PURPOSE: Reuse trusted bounded reader/migration/archive execution without giving clients an IP network.
INPUTS: An already verified role-scoped socket, exact project/environment identity, saved operation fence and deadline.
OUTPUTS: Bounded reader output, migration acknowledgement or a custom PostgreSQL archive; never management credentials.
STEPS:

1. Validate the ephemeral client scope separately from local persistent storage. Development container creation remains Development-only.
2. Inspect the exact socket container, volume, image and environment labels. A matching name alone is insufficient.
3. Record helper intent before creating a network-disabled, read-only container. Pass the role password through stdin and mount only its Unix socket volume.
4. Queries use the trusted reader bundle. Reviewed migrations keep the existing frozen-source and fixed-command contract. Production archive capture uses the trusted PostgreSQL image and migrator role.
5. Bound time, memory and output; verify cleanup before acknowledging the helper. Unknown cleanup retains the caller's saved effect.
6. Restore archives only to a separately identified disposable Development resource. This helper never restores over a Production database.

EDGE CASES: Wrong environment, project, role, volume ownership, changed image or expired fence fails closed. A broker listener does not prove upstream identity; the caller verifies the private TLS target before opening it.
ERROR STATES: Failed/unknown helper work cannot produce a verified backup or successful migration receipt. Resource-level restore comparison and backup sealing remain the API executor's responsibility.
