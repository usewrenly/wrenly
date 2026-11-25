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
   explicitly selected preview, framework and Development app database images.
3. Start only the labelled PostgreSQL composition and apply native control migrations.
4. Start API/web under an identity-bound supervisor; wait for real health responses.
5. Print the protected owner link only in an interactive terminal, and on a local desktop
   offer opening only the public `/setup` page without passing tokens to the browser opener.
EDGE CASES: Resume preserves keys and skips completed steps. Transactional migration
   history recognizes committed migrations after an interrupted acknowledgement. No desktop
   opener or a declined prompt leaves the printed terminal link and keeps setup valid.
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
COMPONENT: Installer terminal presentation
PURPOSE: Make the existing guided flow easier to scan without changing any installation action.
INPUTS: Existing text reports, interactive terminal capability and colour preferences.
OUTPUTS: Restrained wood-coloured headings/status labels, step spinner, summary box and status card in a TTY; identical plain/JSON output otherwise.
STEPS:
1. Number/count applicable installation steps cleanly and animate an inline spinner per step in a decorated TTY without altering underlying journal step names.
2. Style only recognized report labels; render an install summary box and status card cleanly while keeping private setup links undecorated and outside summary boxes.
3. No runtime dependencies; inline prompts only; raw mode always restored; `--yes` and non-TTY streams never prompt.
4. Honour NO_COLOR, CI and TERM=dumb; redirected output and failed checks retain exit codes.
EDGE CASES: Redirected output stays plain; spinner intervals are `.unref()`'d and cleared on exit or error.
ERROR STATES: Presentation never hides a check or turns an uncertain operation into success.

COMPONENT: Interactive installer prompts
PURPOSE: Guide interactive TTY operators through folder, capability presets/custom selection and free ports cleanly without external prompt dependencies.
INPUTS: Partial CLI flags, interactive `PromptIO` stream, destination/port probes and decoration capability.
OUTPUTS: Resolved explicit `install` arguments ending with `--yes`, or exit code 130 on cancellation.
STEPS:
1. Enable raw mode on start, hide cursor, and restore both in `finally`.
2. Skip any prompt whose flag (`--directory`, `--preset`, individual capability flag or port flag) was explicitly supplied.
3. Expand capability implications (`--databases` implies `--previews`, `--inspection` implies `--laravel`), detect busy default ports and offer free candidates (`+1..+50`).
4. Show a collapsed review summary plus equivalent CLI command before final confirmation.
EDGE CASES: Esc/Ctrl+C or negative confirmation rejects with `PromptCancelledError` and exits 130 without touching disk; invalid destination/port inputs show inline amber errors and re-prompt.
ERROR STATES: Non-TTY streams without `--yes` never hang waiting on stdin and reject immediately.

COMPONENT: Development database option and owner setup handoff
PURPOSE: Prepare optional Development app databases and guide the owner to protected setup without leaking tokens.
INPUTS: Explicit `--databases` flag or interactive choice, saved installation ports and desktop session availability.
OUTPUTS: Persisted Development database configuration/images and a token-free browser open prompt.
STEPS:
1. Enable isolated previews whenever `--databases` is selected and build `wrenly/postgres-runtime:17` and `wrenly/database-socket:1`.
2. Persist `WRENLY_APP_DATABASES_ENABLED=true` while leaving Production databases disabled.
3. Run protected `setup-cli.ts` in the interactive terminal, then offer to open only `http://localhost:<webPort>/setup` when a local desktop session is present.
EDGE CASES: No desktop session or a failed browser opener prints the `/setup` URL and keeps the printed terminal link valid. Existing owners cannot be replaced.
ERROR STATES: Failed image builds preserve the journal for explicit `resume`; tokens never enter browser-opener arguments or logs.
