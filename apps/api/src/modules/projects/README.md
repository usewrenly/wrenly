# Projects, permissions and rough ideas

A **project** holds a generated app and its saved versions. A **draft** holds a rough
idea that people can improve before asking Wrenly to build it. Saving a draft does not
call an AI model or create an app.

For example:

> Write a draft → discuss and edit it with invited collaborators → review the saved
> text → explicitly send it as a prompt → Wrenly starts building a project.

## Find the code

```text
access/          Decides who may read, contribute, manage or publish
http/            Lists projects, creates metadata and reads workspace history
settings/        Saves the owner's project name and description
sharing/         Saves collaborator roles and the project's chosen model
archive/         Archives/restores projects without deleting their history
drafts/          Stores plaintext ideas and their sharing settings
tests/unit/      Input, HTTP and permission checks
tests/browser/   Settings/draft interfaces with controlled replies
```

## Who may do what?

The API checks the real signed-in account, then project permissions. Instance
administration does not grant access to someone else's private project.

| Role | Can do |
| --- | --- |
| Owner | Read, contribute and manage the project; publish it |
| Editor | Read and contribute using the project's selected model |
| Viewer | Read and open an authorized ready preview |

Shared access requires current accepted membership. The central rules live in
`access/project-access.ts`; collection queries and individual reads must agree.

## Avoid overwriting another person's change

Suppose you open settings, a teammate changes them, then you save your old form.
Wrenly compares the values or revision you reviewed with the current saved state.
If they differ, it asks you to review the change instead of overwriting it.
This is **compare-and-set**, sometimes shortened to CAS.

Sharing, model, archive and draft changes also carry a unique **request identity**.
If the save succeeds but the reply is lost, retrying that same identity acknowledges
the original action instead of creating another one. An uncertain save remains visible.

Database locks prevent conflicting changes from running at once. Writers acquire
queue, account and project/draft locks in that order to avoid waiting on each other
in opposite directions. Keep the existing active-work and recovery checks intact.

## Archive is reversible retention

Archiving keeps authorized history readable but denies new work and management.
It does not delete Git repositories, stop published apps or remove databases. Restore
does not restart jobs. Drafts have their own archive and saved-action history.

## Contracts and input

A **contract** describes the data a caller may send or receive. Settings and drafts
keep theirs in `settings-contract.ts` and `draft-contract.ts`. Import those definitions
rather than copying them into another feature.

Project creation accepts metadata JSON, limited to 8 KiB and a 5-second read deadline
before any insert. Collection summaries omit source/logs; authorized workspace reads
return saved source, including failed builds. Large-history pagination remains a
separate open performance item; this review does not claim unlimited reads are cheap.

## Check a change

```bash
bun test apps/api/src/modules/projects/tests/unit
bun test apps/api/src/modules/projects/access/project-access.test.ts
```

Database fixtures in `packages/db/tests` verify real transactions using dedicated
throwaway databases. Browser fixtures use controlled replies. Neither should change
operator data or start real generation/publishing merely by running a test.
