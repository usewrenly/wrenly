# Prompt attachments

An attachment gives the model a reference alongside a prompt. For example, someone
can attach a screenshot and ask Wrenly to use its layout, or attach a short document
with requirements. Uploading a file itself never starts a build.

## How the pieces fit

```text
Explicit file selection
  → authenticated bounded upload
  → image sanitizing or strict text decoding
  → private object + personal ownership record
  → authorized conversation/build admission
  → saved immutable reference
  → verified bytes → versioned MCP content → configured model
```

An immutable reference records the exact file identity, length and content hash. A hash
is a fingerprint of the bytes: replacing the file changes it. Requests and retries use
that saved identity, rather than whatever the composer happens to show later.

- `images/` processes images in a disposable worker, strips metadata and preserves
  screenshot proportions. It does not crop them into profile thumbnails.
- `storage/` writes private generated filenames and verifies exact content on reads.
- `attachment-store.ts` owns personal uploads, request binding, authorized reads,
  acknowledgement lookup and expiry tombstones. A tombstone records removal so an
  interrupted cleanup can be retried without accidentally removing a saved reference.
- `attachment-http.ts` supplies injectable HTTP handlers with authentication, origin,
  streaming limits and safe error responses.
- `resolve-content.ts` resolves a saved reference for an already authorized execution.
- Shared contracts in `packages/inference/src/attachments/` validate file budgets,
  saved references, MCP payloads and provider message content.

Unsubmitted uploads belong only to their uploader and expire after 24 hours. Submitted
files belong to saved project history and follow current project-read permissions.
A collaborator losing access cannot continue retrieving them. File contents grant no
model tools, browsing, network access or permission to execute files.

## Integration status

The HTTP factories are not mounted in production yet. Conversation/build admission
requires an injected capability validator for nonempty references; absence fails closed.
Production model-capability configuration, composer controls and cleanup scheduling
must be connected before attachments are available to users. Shared MCP support alone
does not establish that a configured model can interpret images.

## Verification

Focused tests under `tests/` cover decoding, storage, HTTP and saved-content resolution.
`attachments-mcp.integration.test.ts` uses real framework MCP subprocesses with a local
fixture model endpoint when `WRENLY_TEST_MCP=true`; it calls no external model service.
The PostgreSQL ownership suite is in
`packages/db/tests/integration/resources/prompt-attachments.integration.test.ts` and
accepts only an explicitly supplied local `wrenly_attachments_test` database.
