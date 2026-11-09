# Connecting project source

Source control keeps versions of an app in a repository. For example, someone selects
a GitHub commit to bring into Wrenly, edits the app locally, then reviews the changes
before pushing a new branch back to GitHub.

This library starts with the rules for that exchange. It validates repository identity,
the remote file list (a Git **tree**) and bounded text files. A commit or tree SHA is
an identifier for an exact saved Git object, rather than a branch name that can move.
The read-only GitHub client pins credentials to api.github.com and bounds requests.
It accepts only server-resolved tokens; it does not authorize a local user. These
helpers do not authorize an account, execute code or push changes. Account connection
lives in the API and Settings → Connections. Project import and push remain in progress.
The immutable reader verifies each blob against its Git object identity before
returning source; a changed branch cannot alter the selected commit.

```text
src/contracts/           Provider-neutral repository/file identities and safe errors
src/policy/              Paths, excluded configuration and text/size limits
src/providers/github/   GitHub-specific response decoding
tests/unit/             Controlled repository/tree/content cases
```

The API will own Better Auth permissions, personal credentials, durable operations and
explicit confirmation. This package must never turn a valid provider reply into local
project access. Existing Gitea/Coolify publishing stays separate.

Imports reject symlinks, submodules, Git LFS placeholders, binary content and ambiguous
paths. Private environment files and common credential files are excluded; example
configuration templates remain eligible. This is not a general secret scanner: a user
must still review source before importing/exporting. Framework support and Docker
validation are separate checks, not established by a valid file list.

Run from the repository root:

```bash
bun test packages/source-control/tests
bun run --cwd packages/source-control check-types
```
