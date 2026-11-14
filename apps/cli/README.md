# Wrenly setup CLI

This candidate checks a machine before installing Wrenly. For example, it tells you
whether Docker is available or port 3000 is already occupied, without stopping services
or changing permissions. It does **not** install Wrenly yet and is not published to npm.

From the repository root:

```bash
bun --no-env-file apps/cli/src/index.ts doctor
bun --no-env-file apps/cli/src/index.ts plan --directory /absolute/new/wrenly
```

Use `--json` for structured results. Exit 0 means the checks passed, exit 1 means a
prerequisite failed or could not be confirmed, and exit 2 means the arguments are invalid.
Existing directories are not adopted. Disk checks require 10 GiB initially; generated
apps and Docker images need more. Port checks briefly bind loopback and immediately
close the socket. No instance configuration or credentials are read.

The first supported target is Linux x86_64 with Bun 1.3.14+, Node 24+ and local Docker.
The CLI does not install those prerequisites, use sudo, contact a Wrenly service,
start containers, modify configuration, or create an owner account.

Contributor code groups argument validation, inspection, local probes and terminal
output separately under src/. Tests inject probes and exercise the bundled executable
outside the monorepo. Build with `bun run --cwd apps/cli build`.
