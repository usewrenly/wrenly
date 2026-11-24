# Provider setup forms

These forms let the instance owner connect a model-hosting service from Settings.
For example, save an Ollama server address, check its installed models and choose
which model new requests should use. The API verifies ownership on every operation.

- `add-provider.tsx` reviews a local, catalog or custom destination and creates a
  connection. Catalog searches cancel when the query changes. A lost save response
  retains its request ID for an exact retry; changing the form creates a new identity.
- `provider-connection.tsx` renders saved connections as grid cards or table rows with
  quick **Models**, **Edit**, **Disable / Enable**, and **Remove** actions.
- `provider-connection-dialog.tsx` provides a unified tabbed dialog for editing
  display name, endpoint URL, replacement token, enabled state, model checks /
  instance default selection, and reviewed image-input model IDs. Same-origin URL
  fixes preserve the saved token while rotating the connection version; cross-origin
  host changes require re-entering the token.
- `provider-remove-dialog.tsx` handles confirmation-gated deletion with clear notices
  for instance defaults, imported environment sources, and bound project blockers.
- `import-environment-provider.tsx` requests a server-side copy of an existing
  environment credential. It never receives that credential in its response.

Tokens typed into password fields stay in component memory until submitted. They
are not browser preferences, and saved tokens are not read back into these forms.
A connection check lists served models; a catalog/manual model ID is not proof that
that account can use it. A request timeout does not prove a save was rejected: refresh
saved connections and follow the offered retry guidance before creating another one.

The data clients and parsers live in `lib/models`; the page coordinating these forms
is `app/(app)/settings/providers/page.tsx`. `DESIGN.md` explains operation order and
failure handling. Local Chrome acceptance lives in the API models browser test folder.
