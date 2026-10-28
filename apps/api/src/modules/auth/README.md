# Who can use this Wrenly instance?

**Authentication means checking who is signed in. Authorization means checking what
that person may do.** Both matter, even when one person hosts Wrenly for themselves.

For example:

> You open Wrenly → sign in with your instance account → Wrenly checks your session →
> each project checks whether you may read or change it.

Better Auth handles passwords and sessions. A **session** is the server record behind
your signed-in browser. Wrenly adds owner setup, invitations, suspension and project
permissions. No external Wrenly account is required.

## Find the code

```text
access/          Checks the current session and carries its identity through a request
configuration/   Public Better Auth settings and private account-management helpers
setup/           First-owner setup, local commands and setup progress
invitations/     Inviting people and accepting or revoking invitations
members/         Suspending and restoring existing members
password-recovery/ Private-link credential reset issued by a local server command
recovery/        Protected recovery for an existing owner or old test projects
profile/         Display names and picture uploads
tests/unit/      Rules, HTTP handlers and image-decoder checks
tests/browser/   Real interfaces with fake service replies
```

## The first account and later accounts

The person operating the server runs the setup command. It prints a private, expiring
link containing a **proof**: a secret code that authorizes first-owner setup. The owner
sets credentials in the browser, then signs in normally. Later accounts require an
owner-issued invitation. Ordinary public signup is closed.

`configuration/auth.ts` is the Better Auth handler exposed over HTTP.
`configuration/instance-auth.ts` is a private SDK used only after Wrenly authorizes a
setup, invitation or member operation. Never expose that private SDK as an HTTP handler:
it can create accounts because its caller has already checked permission.

Account creation, membership and proof consumption share a database **transaction**:
either all their writes succeed, or all roll back. A failed invitation acceptance must
not leave a half-created account or consume the invitation without adding the member.
The shared configuration types live in `setup/owner-account.ts`; import them rather
than copying definitions. Never log passwords, proofs or session tokens.

## Access can change while a request is running

Suspension revokes sessions and preview access while preserving projects and history.
Restore requires a new sign-in; it does not revive old cookies or restart jobs.

Wrenly records an **access revision**, an identifier that changes when account access
changes. A request remembers the revision it authenticated with. Before saving work,
the database checks that revision again. This prevents an old request from continuing
with permission it has lost. Active or unresolved work can block a suspension until it
is safely finished or checked.

Instance administration is separate from project access. Being the instance owner
does not automatically let someone read another person's private project.

## Recovery and pictures

Existing-owner recovery requires both an operator-issued proof for a specific account
and a real sign-in to that account. It never replaces credentials or silently transfers
projects. Recovery of projects from the former fixed local identity requires a separate,
explicit review and confirmation; active work and stale reviews block the transfer.

Picture uploads have size/time limits. A separate short-lived process reads the image,
removes metadata and produces a standard WebP. Stored revisions prevent an old upload
from overwriting a newer one. Picture reads check current account, directory or visible
project-author access; knowing a user ID alone is insufficient.

## Setup state is not a user count

`/api/instance/setup` distinguishes first setup, initialized instances and recovery.
`/api/instance/access` reports sign-in access. A failed request never means the instance
is empty. The old public account-count endpoint has been removed.

## Check a change

```bash
bun test apps/api/src/modules/auth/tests/unit
bun run --cwd apps/api check-types
```

Browser tests use fake service replies. Native credential creation, rollback and
revocation are also checked with a separate disposable PostgreSQL database. Skipped
tests are not evidence that those paths work; never run fixtures against instance data.

## Forgotten passwords

For example: you forgot your password → run `bun run recover-password your-email@example.com`
inside `apps/api` on your server → open the private link → choose a password → sign in.
The command selects an existing account; it never creates one or transfers projects.
The public endpoint accepts a proof but cannot issue one. Better Auth's private SDK
changes the credential inside the same transaction that revokes sessions, updates the
account access revision and records the completion receipt. Raw native reset endpoints
remain closed. This local flow sends no email; optional instance mail recovery is pending.

Short-lived proof hashes and completion receipts use Better Auth's verification table
with a separate Wrenly prefix. A receipt stores an HMAC (a secret-key fingerprint), not
the new password. It lets the same request recover a lost acknowledgement without
changing credentials again. It expires after 24 hours; unused proofs expire in ten minutes.
`access/account-work.ts` shares queue locking and active-work checks with member access.
