# Showing source as folders

A generated booking app contains paths such as `app/page.tsx` and `package.json`.
`source-tree.ts` turns those paths into folders and files for the code editor's
sidebar. It keeps each file's original array index, so selecting a sorted entry
still opens the correct saved content.

Folders sort before files at every depth. Search keeps matching files together
with their parent folders. File names remain plain data; names such as `__proto__`
do not become object properties because folder lookup uses a Map.

This is a display helper, not a filesystem writer or permission check. Source
export has its own stricter path and collision validation. The consumer is
`components/workspace/artifacts/code-editor.tsx`.

From the repository root:

```bash
bun test apps/web/lib/source-browser/tests/unit
```
