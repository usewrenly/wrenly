# Provider setup forms

These forms let the instance owner connect a model-hosting service from Settings.
For example, save an Ollama server address, check its installed models and choose
which model new requests should use. The API verifies ownership on every operation.

- `add-provider.tsx` reviews a local, catalog or custom destination and creates a
  connection. Catalog searches cancel when the query changes. A lost save response
  retains its request ID for an exact retry; changing the form creates a new identity.
- `provider-connection.tsx` checks a saved connection, updates its default model,
  replaces a token or enables/disables it. A destination is immutable: changing where
  credentials are sent requires reviewing and creating a new connection.
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
