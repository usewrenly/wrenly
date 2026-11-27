# Wrenly setup CLI

The installer prepares a local Wrenly instance for you. It checks your machine,
downloads a verified source release, creates private configuration, builds Wrenly,
and starts its own PostgreSQL database and web/API processes. You choose your account
password in the existing protected browser setup. Invited teammates do not install it.

This first version supports **Linux x86_64 on the same computer as your browser**.
Install Bun 1.3.14+, Node 24+, Docker Engine with Compose v2, and util-linux (`flock`)
first. Your account needs access to the local Docker socket. The CLI does not use
sudo, install prerequisites or change permissions on Docker. Allow at least 10 GiB
on the destination disk, plus room for generated apps and Docker images.

## Quick start

Run the guided installer with Bun:

```bash
bunx @wrenly/cli@beta
```

Or inspect your host and review the exact installation plan without making any changes:

```bash
bunx @wrenly/cli@beta doctor
bunx @wrenly/cli@beta plan --directory "$HOME/wrenly"
bunx @wrenly/cli@beta install --directory "$HOME/wrenly"
bunx @wrenly/cli@beta install --preset recommended --yes
```

Interactive reports use colour; `NO_COLOR=1` disables it. Redirected output
and JSON remain plain. Help and the installation summary include an optional major-updates
link. Subscription happens only on the website; the CLI never collects or sends an email address.

Running without arguments or `install` without `--yes` in an interactive TTY opens guided
prompts for any omitted folder, capability preset/custom options, or ports—flags you supply
explicitly skip their corresponding prompts. Pressing Ctrl+C or Esc inside any prompt cancels
cleanly with exit code `130`. `--yes` provides explicit confirmation for non-interactive
runs (and non-TTY runs require `--yes`). `--preset <minimal|recommended|full>` selects a
capability bundle (`minimal`: core workspace only; `recommended`: previews, Laravel 13,
app databases, and framework inspection; `full`: recommended plus voice dictation) and
cannot be combined with individual capability flags.

If a port is occupied, choose another rather than stopping an unrelated service:

```bash
bunx @wrenly/cli@beta install \
  --directory "$HOME/wrenly" \
  --web-port 41000 --api-port 41002 --database-port 65433 \
  --previews --preview-port 41003 --databases
```

Use a short absolute path with letters, numbers, `/`, `.`, `-` or `_`, and an existing
parent directory. Existing destinations and symlink ancestors are refused. `--previews`
prepares the Next.js preview image; `--laravel` builds the repository's Laravel toolchain
and should be paired with `--previews` if you want Laravel previews; `--databases`
enables Development app databases alongside isolated previews and builds the trusted
PostgreSQL (`wrenly/postgres-runtime:17`) and socket (`wrenly/database-socket:1`) images;
`--inspection` enables official framework inspection (`WRENLY_FRAMEWORK_INSPECTION_ENABLED=true`)
and builds `wrenly/laravel-runtime:13-php8.4`, `wrenly/framework-inspection-laravel:1`, and
`wrenly/framework-inspection-nextjs:1`; `--dictation` enables local voice dictation
(`WRENLY_DICTATION_ENABLED=true`), downloads checksum-verified Whisper `ggml-base.bin` weights
from Hugging Face into `.wrenly/speech/`, and builds `wrenly/transcription-runtime:1`.
Production app databases and publishing require a separate server/host connection setup
and stay disabled by default. Downloads require internet during setup. No Wrenly cloud
account is required.

## Create your owner account

After an interactive install, the CLI prints a private setup link. On a local desktop
session, it automatically opens the public `/setup` page in your browser without
passing the one-time token in browser arguments; copy or keep the private `#setup=`
link printed in the terminal to finish creating your owner account within ten minutes.
Do not share or record that link. A non-interactive installation prints instructions to run:

```bash
bunx @wrenly/cli@beta setup --directory "$HOME/wrenly"
```

Run that in an interactive terminal. It reuses protected owner setup and cannot replace
an existing owner. After sign-in, open **Settings → Providers**, connect your model,
then create a project. If you enabled `--databases`, approve project database storage
and migrations directly in the project conversation; Production databases and publishing
still have their own separate setup guides.

## Start, stop and check

```bash
bunx @wrenly/cli@beta status --directory "$HOME/wrenly"
bunx @wrenly/cli@beta stop --directory "$HOME/wrenly"
bunx @wrenly/cli@beta start --directory "$HOME/wrenly"
```

Start and Stop ask for confirmation; use `--yes` after reviewing the action if needed.
Stop preserves PostgreSQL's volume, accounts, projects and keys. Start checks the saved
configuration and resource ownership. It never adopts a process just because its port
matches, and it never signals a saved process ID. API/web services run locally and need
an explicit Start after a reboot. This is not a system service or a remote HTTPS setup.

`status --json` returns structured non-secret state. Exit 0 means the requested action
succeeded (or status is running); exit 1 means a check/action failed or remains
unconfirmed; exit 2 means invalid arguments. Doctor and Plan also support JSON and never
install anything.

## Interrupted installation

```bash
bunx @wrenly/cli@beta status --directory "$HOME/wrenly"
bunx @wrenly/cli@beta resume --directory "$HOME/wrenly"
```

Resume requires confirmation and preserves the original keys. A kernel lock prevents
it from overlapping an older command that survived a lost terminal. Committed control
database migrations are recognized by their existing migration journal, rather than
applied twice. Resume does not upgrade a ready installation.

If extraction or private configuration never completed, Resume refuses the partial
installation. Preserve that directory for inspection and choose a different empty
path; do not copy another instance's keys or invent replacement keys. If runtime
ownership is uncertain, Stop leaves the database running rather than risking its data.

Private files live in the installation: `.env`, `apps/web/.env.local` and `.wrenly/`.
The journal contains release identity and step receipts, not secrets. `.wrenly/runtime.log`
contains local API/web diagnostics and should be treated as private. Back up the root
`.env`, `.wrenly/data` and the PostgreSQL data together using the backup guide. A source
archive alone is not a backup of accounts or projects.

## Release integrity and scope

This CLI pins public commit `0ca419a989b17e4affaa925e1e78b35aa0d38543` and checks the
archive's SHA-256 before extracting or executing source. It rejects links, unsafe paths,
collisions and oversized archives. `--archive /absolute/source.tgz` accepts only those
same pinned bytes; it does not allow arbitrary code or a moving branch. The checksum
is an integrity check, not a publisher signature. Dependencies come from the pinned
lockfile with installation scripts disabled.

There is no automatic upgrade, uninstall, destructive reset, package publication or
telemetry in this version. The installer does not change another Wrenly installation.

## Contributor map

- `src/install/`: release verification, archive checks and private installation records.
- `src/runtime/`: bounded local commands, kernel locks, labelled Docker resources and
  the supervisor that owns this installation's API/web child processes.
- `src/commands/`: installation steps and explicit lifecycle actions.
- `tests/`: archive attacks, private-file preservation, command checks, real child-process
  lifecycle and a packed executable running outside the monorepo.

Run `bun run --cwd apps/cli build`, `bun run --cwd apps/cli test`,
`bun run --cwd apps/cli check-types`, and `bun run --cwd apps/cli lint` from the repository root
to build `apps/cli/dist/wrenly.js` and run the CLI checks locally.

The opt-in real installation test downloads the pinned release, builds it and creates
a dedicated PostgreSQL volume. It preserves its private test directory/data for review:

```bash
WRENLY_TEST_INSTALLER=true bun --no-env-file test apps/cli/tests/lifecycle.integration.test.ts
```
