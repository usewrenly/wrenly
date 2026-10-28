# Choosing which logs to show

If someone selects revision 02 of a booking app, its Logs view must not show the
preview output from revision 03. This folder selects recorded information that
matches the revision being viewed. It does not fetch logs or start any work.

A **diagnostic source** is one labelled group of recorded information: build output,
preview output or publishing status. Publishing status is not the deployed app's
runtime log; the interface must keep that distinction visible.

`workspace-diagnostics.ts` combines the current build, preview and publishing
snapshots. A snapshot is the state already loaded by the corresponding React hook.
The function checks revision identities before including output. Loading, disabled,
unsupported and failed-refresh states get their own explanations, rather than
showing stale output as current. Each source retains at most 256,000 characters.

Search treats logs as plain text. It does not execute commands or interpret HTML,
severity or timestamps supplied in the recorded output. The UI is
`components/workspace/artifacts/workspace-logs.tsx`; its existing controllers still own all
network requests and authorization.

From the repository root:

```bash
bun test apps/web/lib/diagnostics/tests/unit
```

The tests cover revision changes, failed reads, size bounds and literal text search.
Full browser presentation checks live with the API conversation browser fixtures.
