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

## Try the unpublished candidate

From this feature checkout, build the standalone executable:

```bash
bun install --frozen-lockfile
bun run --cwd apps/cli build
bun --no-env-file apps/cli/dist/wrenly.js plan --directory "$HOME/wrenly"
bun --no-env-file apps/cli/dist/wrenly.js install --directory "$HOME/wrenly"
```

Interactive reports use restrained colour; `NO_COLOR=1` disables it. Redirected output
and JSON remain plain. Help and the installation summary include an optional major-updates
link. Subscription happens only on the website; the CLI never collects or sends an email address.

Review the plan and type `install` to proceed. Running the executable without arguments
in an interactive terminal opens the guided questions instead. `--yes` provides explicit
confirmation for a non-interactive install after reviewing the same plan.

The bundled `dist/wrenly.js` also works outside this repository; only Bun is needed to
run the CLI itself. Node and Docker are needed to install/run Wrenly. The npm package
is not published yet, so there is no `bunx @wrenly/cli` installation command today.

If a port is occupied, choose another rather than stopping an unrelated service:

```bash
bun --no-env-file apps/cli/dist/wrenly.js install \
  --directory "$HOME/wrenly" \
  --web-port 41000 --api-port 41002 --database-port 65433 \
  --previews --preview-port 41003
```

Use a short absolute path with letters, numbers, `/`, `.`, `-` or `_`, and an existing
parent directory. Existing destinations and symlink ancestors are refused. `--previews`
prepares the Next.js preview image; `--laravel` builds the repository's Laravel toolchain
and should be paired with `--previews` if you want Laravel previews. Downloads require
internet during setup. No Wrenly cloud account is required.

## Create your owner account

After an interactive install, the CLI prints a private setup link. Open it within ten
minutes, choose your account details, then sign in normally. Do not share or record
that link. A non-interactive installation prints instructions to run:

```bash
bun --no-env-file apps/cli/dist/wrenly.js setup --directory "$HOME/wrenly"
```

Run that in an interactive terminal. It reuses protected owner setup and cannot replace
an existing owner. After sign-in, open **Settings → Providers**, connect your model,
then create a project. Publishing and generated-app databases have their own optional
setup guides; the installer leaves them disabled.

## Start, stop and check

```bash
bun --no-env-file apps/cli/dist/wrenly.js status --directory "$HOME/wrenly"
bun --no-env-file apps/cli/dist/wrenly.js stop --directory "$HOME/wrenly"
bun --no-env-file apps/cli/dist/wrenly.js start --directory "$HOME/wrenly"
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
bun --no-env-file apps/cli/dist/wrenly.js status --directory "$HOME/wrenly"
bun --no-env-file apps/cli/dist/wrenly.js resume --directory "$HOME/wrenly"
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

This CLI pins public commit `ed4a25445c1bc22ece10bcf2d0887354d7367839` and checks the
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

Run `bun run --cwd apps/cli test`, `bun run --cwd apps/cli check-types`,
`bun run --cwd apps/cli lint` and `bun run --cwd apps/cli build` from the root.

The opt-in real installation test downloads the pinned release, builds it and creates
a dedicated PostgreSQL volume. It preserves its private test directory/data for review:

```bash
WRENLY_TEST_INSTALLER=true bun --no-env-file test apps/cli/tests/lifecycle.integration.test.ts
```
