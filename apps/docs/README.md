# Wrenly handbook

This app serves Wrenly's public documentation. Its homepage leads to `/docs`, where
people can install an instance, learn the workspace and understand its architecture.
It does not connect to an instance database or require external services.

## Run and check

From the repository root:

```bash
bun install --frozen-lockfile
bun run --cwd apps/docs dev
```

Open http://localhost:3001/docs. Public MDX comes only from `content/docs`.
Search uses that compiled collection locally; bundled fonts and assets work offline.
Optional GitHub/Discord destinations are explained in `.env.example` and validated at
startup. Omit them until actual destinations are available.

```bash
bun run --cwd apps/docs docs:check
bun run --cwd apps/docs check-types
bun run --cwd apps/docs lint
bun run --cwd apps/docs build
```

## Find the code

| Path | Purpose |
| --- | --- |
| `content/docs` | Public guides and navigation metadata |
| `components/documentation` | Handbook navigation, cards, diagrams and screenshots |
| `components/brand-mark.tsx` | Adapter for the shared brand artwork |
| `lib/source.ts`, `source.config.ts` | Load only the compiled public guide collection |
| `app/docs`, `app/api/search` | Handbook routes and bounded local search |
| `app/documentation.css` | Handbook styling |
| `tests` | Unit and opt-in built-route/browser acceptance |

Keep explanations concrete: what a reader is trying to do, what happens and why it
matters. Read the root contributor guide before changing public behavior.
