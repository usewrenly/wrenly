# Checking source before execution

A model returns files for a booking app. Before Wrenly writes or runs them, these
checks reject unsafe paths and unsupported framework configuration. They read source
as data; they never import a generated config file into the API to inspect it.

- `file-paths.ts` rejects escaping, duplicate and file/directory-conflicting paths.
  For example, `../outside.ts` cannot write beyond the workspace.
- `nextjs-styling.ts` checks the Tailwind configuration and stylesheet wiring needed
  for supported Tailwind 3 output. Installing a package alone does not generate CSS.
- `laravel-runtime.ts` checks Laravel 13 source and defines trusted installation and
  validation commands. Composer plugins/scripts and Bun install hooks stay disabled.

These checks cannot prove an app is correct or harmless. Actual generated execution
still belongs inside resource-limited Docker containers with networking blocked after
installation. Builds, previews and runtime-image packaging reuse these checks so the
same source does not receive contradictory basic policy in different flows.

## Managed database connection mistakes

For example, a notes app can compile but fail its first browser request because its
connection module uses an invented localhost database URL. A managed Wrenly database
instead receives a private Unix-socket host and role through PG* runtime settings.
`managed-postgres-source.ts` checks known incompatible Postgres.js URL patterns while
reading the saved source. The database manifest reader returns its fixed repair message
before execution. It never imports that source or reveals credential values.

This focused check is not a JavaScript interpreter or complete connection audit. It does
not replace the container's blocked IP networking, role restrictions or real runtime
checks. Applications must also validate API responses and display request failures;
an HTTP-ready root page alone is not a browser interaction test.

Managed server pages must also render at request time. For example, an async notes
page that calls getNotes during prerendering tries to reach a database during the
network-disabled build. Add `export const dynamic = 'force-dynamic'` to its server
page or root layout (or `export const revalidate = 0`). The manifest reader enforces
this existing generation requirement before creating a validation operation, so the
model can repair that source mistake without asking the user to recover resources.
Client pages remain eligible, with their own response validation/error handling.
