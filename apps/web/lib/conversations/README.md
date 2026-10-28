# Sending and restoring a conversation

When you ask “Why did that build fail?”, Wrenly saves your message and the model's
reply. This folder checks that saved data and sends new messages to the API. It
does not call a model or decide whether a message should start a build.

A **turn** is one submitted request and its resulting work. A turn can answer a
question, help plan an app or start a build. Auto and Plan are the current composer
choices; Ask and Build remain readable for older saved conversations.

## Find the responsibility

- `contracts.ts` defines browser data shapes and checks incoming history and saved
  requests. A contract is the expected shape of data, not permission to access it.
  The API still verifies every request's user and project access.
- `client.ts` submits one request. Its **idempotency key** identifies that same
  request across retries, so a lost HTTP response cannot create a second turn.
  The serialized message, model and selected revision stay identical on each retry.
- `tests/unit` covers malformed history, uncertain acknowledgements and exact retries.
- `hooks/use-conversation.ts`, outside this folder, connects these functions to React,
  reads history pages, polls for changes and stores unresolved requests in tab-local
  session storage so refresh can recover them.

An **uncertain acknowledgement** means the API may already have saved the message,
but the browser cannot confirm it. The client keeps the original request for a
same-key check instead of telling the user it definitely failed. Explicit rejection
is different: it returns the API's safe explanation for the user to correct.

The selected build ID refers to the saved source revision the user was viewing;
it must not silently change to the newest revision during recovery. Conversation
history stays intact when a prompt is edited and resubmitted: that action creates
a new request, rather than rewriting the old message.

## Check changes

From the repository root:

```bash
bun test apps/web/lib/conversations/tests/unit
```

These tests use local HTTP response fixtures. Full browser recovery and project
switching tests live with `apps/api/src/modules/conversations/tests/browser`.


An optional database choice uses the shared pure `BuildDatabaseSelection` contract.
Restoring a saved request preserves its exact resource/revision, and malformed choices
fail restoration instead of becoming stateless. Turn summaries may contain the same
non-secret choice; retry reuses it rather than the current composer selection. No
credentials, addresses or SQL belong in this field.
