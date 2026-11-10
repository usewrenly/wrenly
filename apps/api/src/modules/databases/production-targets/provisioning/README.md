# Remembering a Production database creation

Suppose Coolify creates a database but the API loses its response. Sending Create
again could leave two databases. This folder saves the request before contacting
Coolify and keeps an uncertain result for inspection instead of repeating it.

- `store.ts` checks the current project owner and session, saves the exact reviewed
  provider placement, encrypts generated credentials, and gives one worker a claim.
- `worker.ts` holds the existing resource kernel lock, saves the external-effect
  intent, makes one provider call and saves its UUID or uncertain outcome.
- The PostgreSQL integration suite exercises those real transactions, the shared
  work blockers and the resource lock against a controlled provider reply.

A claim is temporary permission for one worker to handle a saved request. A kernel
lock prevents another local process from working on the same resource while that
worker is alive. Both are needed: database expiry alone cannot prove an old process
has stopped.

`created` means Coolify returned an identity. It does not mean the database is
running or ready. That state still blocks conflicting project/member actions until
verified private TLS, separate SQL roles and runtime attachment are complete.
Unknown outcomes retain their encrypted credentials and never return to the queue.

The setup credential key is stored in `production-provision-keys` within the
instance data directory. Restore it together with the control database; it is not
replaced when saved encrypted credentials exist.

No browser route or startup worker is enabled by this module. Startup checks that
the journal migration exists because shared project/member admission reads it.
Apply all checked-in Drizzle migrations before running this branch. This module
never runs those migrations against an installation automatically.
