# Guided local installation

Wrenly's CLI turns a new folder into a working local instance. For example, a person
chooses a folder and ports, reviews the plan, and creates their first account in the
browser. It manages trusted Wrenly services; generated applications still run in Docker.

COMPONENT: Machine checks and confirmation
PURPOSE: Explain prerequisites before changing the machine.
INPUTS: Strict command/option allowlist, installation path and service ports.
OUTPUTS: Human-readable checks or versioned JSON; explicit confirmation before writes.
STEPS:
1. Check Linux x86_64, Bun, Node, local Docker/Compose, kernel locks, disk and ports.
2. Report every missing or unconfirmed prerequisite independently.
3. Show the exact destination and services; require confirmation for installation.
EDGE CASES: Existing directories and occupied ports are never adopted.
ERROR STATES: Invalid arguments exit 2; unavailable prerequisites exit 1 without mutation.

COMPONENT: Verified source and private configuration
PURPOSE: Prepare a new installation without overwriting another instance's files.
INPUTS: Pinned public commit, SHA-256 archive identity and reviewed settings.
OUTPUTS: Private source directory, stable keys and a non-secret installation journal.
STEPS:
1. Download a bounded immutable archive or read an explicitly supplied local archive.
2. Verify its checksum and inspect all entries before creating the destination.
3. Reserve a private new directory. Record incomplete preparation before extraction;
   use exclusive file creation, reject links and never execute partial source.
4. Generate keys once, write private configuration, then record prepared state.
EDGE CASES: A crash during preparation leaves an incomplete directory for inspection;
   it cannot regenerate keys or silently become a different installation.
ERROR STATES: Wrong checksum, unsafe paths, collisions or missing private files stop setup.

COMPONENT: Installation steps
PURPOSE: Build trusted source and start dedicated local services.
INPUTS: Verified release, private configuration and exact installation identity.
OUTPUTS: Completed dependency/build/schema/runtime receipts and actual health checks.
STEPS:
1. Hold a kernel command lock. A second step lock stays with surviving child commands,
   preventing Resume from overlapping work after a lost terminal.
2. Install locked dependencies without lifecycle scripts, build API/web and prepare
   explicitly selected preview/framework images.
3. Start only the labelled PostgreSQL composition and apply native control migrations.
4. Start API/web under an identity-bound supervisor; wait for real health responses.
5. Print the protected owner link only in an interactive terminal.
EDGE CASES: Resume preserves keys and skips completed steps. Transactional migration
   history recognizes committed migrations after an interrupted acknowledgement.
ERROR STATES: Unconfirmed steps remain visible; no automatic upgrade or destructive reset.

COMPONENT: Status and Stop/start
PURPOSE: Manage only the installation's own services while preserving data.
INPUTS: Private journal, matching configuration and explicit lifecycle action.
OUTPUTS: Verified service state and preserved PostgreSQL volume/configuration.
STEPS:
1. Verify private file ownership, exact composition and labelled database storage.
2. Use a private Unix socket to contact the supervisor that owns API/web child handles.
3. Stop API/web before stopping PostgreSQL; preserve all data and keys.
4. Start only after checking resource identity and free ports; never adopt by PID/port.
EDGE CASES: Stale sockets can be removed only under the runtime kernel lock. Unknown
   process ownership leaves PostgreSQL running for inspection.
ERROR STATES: Wrong identity, changed storage or unconfirmed shutdown prevents mutation.

This version is local Linux setup, not remote TLS, an operating-system service,
auto-update, uninstall or an npm publication workflow.
