# Saved text and passive assets

An imported logo must remain the same logo after a heading edit. A revision therefore
keeps text and passive binary objects distinct. Each asset has a SHA-256 identity,
media type, byte length and canonical base64 bytes. The file's `asset` field refers to
that immutable object; its text content must be empty. Existing private JSON revision
storage keeps both together atomically, including retry and review snapshots. No new
public asset URL or external storage service is involved.

Before a filesystem write, validate the object, format and hash and materialize its
original bytes. MCP inputs contain text only; assets and text omitted for context size
stay unchanged when explicit edits merge into the complete revision. A model cannot
replace an asset with text. ZIP downloads preserve bytes. GitHub branch pushes retain
unchanged asset objects through the pinned base tree; new binary writes are rejected.

Budgets distinguish text, passive assets, serialized revision storage and model input.
An instance can lower or raise import budgets within the shared runtime ceilings;
request bodies cannot override them. Unsafe paths, ambiguous names, unsupported binary
formats, mismatched hashes, malformed objects and incomplete reads reject the snapshot.
