# Wrenly web app

This app is the browser interface for Wrenly. For example, when you send “Build a
booking app”, it sends that request to the Wrenly API and displays the saved
conversation, generated files, validation output and preview.

The API owns execution and checks permissions. Closing a tab stops that tab's
updates; it does not cancel the server's build. Reopening the project restores
saved work. Every installation requires sign-in through Better Auth, including
an installation used by just one person.

## Run locally

From the repository root, install dependencies with `bun install`. Configure
`apps/web/.env.local` using `.env.example` in this directory, then run:

```bash
bun run --cwd apps/web dev
```

Start the API separately using its README. The web app listens on port 3000.
`NEXT_PUBLIC_API_URL` is the API origin reachable from the Next.js server, usually
`http://localhost:3002`. Next.js forwards browser `/api` requests there. Set an
origin only, without `/api`, credentials, query parameters or a fragment.
`NEXT_PUBLIC_WEB_URL` is the browser-facing web origin used by Better Auth.
These public settings must never contain tokens or passwords.

`NEXT_PUBLIC_DOCS_URL` optionally points to your documentation site's `/docs`
entry. Development defaults to local docs on port 3001; production has no invented
help address. Running local documentation does not require a hosted search account.
Restart Next.js after changing configuration.

## Find the code

- `app/(auth)` contains sign-in, protected owner setup and invitation screens.
- `app/(app)` contains the authenticated dashboard, projects and settings.
- `components/workspace` presents conversations, saved source, previews and logs.
- `hooks` connects screens to ongoing work and restores saved state.
- `lib` contains browser request clients, validation and state transitions.
- `lib/configuration` validates configuration used by the Next.js server.
- `lib/builds` groups build submission, saved state and progress events, with its
  own tests and a guide to reconnection.
- `lib/previews` checks preview navigation links; `lib/deployments` preserves the
  publishing request identity before submission.
- `lib/source-download` exports the selected saved revision; `lib/source-browser`
  groups file paths for the editor, and `lib/diagnostics` selects matching recorded logs.
- `components/auth` gates entry/private screens, `lib/auth` holds the Better Auth
  browser client and `lib/onboarding` validates authenticated setup progress.
- `components/account` presents profile pictures; `lib/accounts` handles picture
  metadata and invitation/member request transport.
- `components/drafts` and `lib/projects/drafts` own saved ideas and their reviewed
  handoff to the composer, separately from generated projects.
- `lib/skills` separates saved instruction contracts from requests;
  `lib/projects/settings` handles project-detail saves and conflict snapshots.
- `lib/models` groups model discovery, deliberate default selection and provider
  setup requests.
- `lib/conversations` checks saved messages and submits conversation requests;
  its guide explains uncertain responses and recovery.

A request client sends and receives data; it does not decide whether a user may
access a project. The API rechecks that permission. Model credentials and model
requests remain server-side. Downloading source uses the explicitly selected saved
revision rather than substituting whichever revision happens to be newest.

## Check changes

```bash
bun run --cwd apps/web check-types
bun run --cwd apps/web lint
bun run --cwd apps/web build
bun test apps/web/lib/configuration
```

Configure the public origins before running Next.js checks. The focused command
above tests proxy configuration, not every screen. Browser acceptance fixtures
also live with the API modules whose behavior they exercise; see their READMEs.
The current review is proceeding feature by feature, including folder organization;
this directory map does not mean the whole web app has completed review.
