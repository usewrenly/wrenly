# Downloading saved source

When someone selects revision 02 of a booking app and clicks **Download source**,
Wrenly downloads revision 02—even if revision 03 exists. It checks access again
before exporting. A denied read never falls back to files already visible in the UI.

- `client.ts` reads the authenticated build endpoint without caching, checks the
  returned revision identity and requires finished work with saved files. It bounds
  the response to 32 MiB and cancels/releases the response reader after use.
- `zip.ts` creates a standard ZIP containing only saved file paths and text. It
  does not add logs, job metadata or runtime-only credentials. Saved source text is
  preserved as supplied, not scanned or redacted. It rejects unsafe paths,
  extraction collisions and files that cannot be preserved as UTF-8 text.
- `tests/unit` checks exact-source export, rejection/cancellation and archive limits.
  Python's ZIP reader independently verifies the resulting archive and exact content.
- `tests/browser` exercises the real download component with local API fixtures.

The component at `components/workspace/artifacts/source-download.tsx` cancels on revision
change or unmount, sets a 20-second deadline and releases the temporary browser file
URL after starting the download. Exporting never starts a build or publishes an app.
The API, not the button's enabled state, decides whether the user can read source.

The archive supports up to 1,000 files and 20 MiB of source text. Bounds are checked
before allocating the final archive. Platform-reserved names and case/Unicode
collisions are rejected so extraction does not overwrite a different file.

From the repository root:

```bash
bun test apps/web/lib/source-download/tests/unit
```

Browser acceptance requires local Chrome and its explicit opt-in; it does not call
models, email services or deployment providers.
