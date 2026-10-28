# Choosing models and connecting providers

A **provider** is the service hosting a model. For example, Ollama on your server
can serve a local coding model, while a hosted provider can serve a cloud model.
A **model** is the particular model identifier you choose from that service.

When you choose a model for a booking app, the browser sends that choice to Wrenly.
The API finds the saved connection and calls the provider. Provider credentials
stay on the server; model requests never go directly from the browser to a provider.

## Find the code

- `discovery.ts` reads available models from `/api/models`, validates the response
  and connects it to React Query, which caches fetched data between renders.
  It also stores this browser's explicit model/provider preference.
- `provider-settings.ts` reads safe connection/catalog metadata and submits setup
  requests to Wrenly. Its parsers retain fields the UI needs, not saved tokens or
  encrypted credentials. A password typed into the setup form is sent to the API;
  it is not returned when reading saved connections.
- `tests/unit` covers selection and response validation.

The settings screens live in `app/(app)/settings/models` and `settings/providers`;
connection forms live in `components/settings/providers`. The API enforces owner-only setup.
Hiding a browser form is not a substitute for that permission check.

## Defaults must be deliberate

An instance default is stored by the API. A device override is a choice saved in
this browser. They are separate: clearing the device choice returns to the instance
default; it does not change what teammates use.

The device preference saves its model/provider pair in one browser-storage record.
If storage is blocked, unreadable or full, the UI explains the failure. It does not
claim the choice was saved or silently substitute the instance default. Allow site
storage and choose again. Existing complete older preferences remain readable;
resetting writes an explicit default choice that overrides those older keys.

A model ID alone is not enough. Two providers can serve the same ID, with different
cost or behavior. Selection therefore uses the provider/model pair. A missing or
unavailable default leaves the choice unset instead of selecting the first offered
model. A complete explicit device choice stays visible even if unavailable, so the
user can correct it rather than unknowingly sending work elsewhere. Shared projects
have an API-enforced project model; a personal picker cannot override that binding.

Connection checks distinguish an empty local service from a failed request. Installing
models on the Wrenly server is different from installing them on the visitor's laptop.
A catalog entry is discovery information, not a guarantee that its native protocol is
supported. Current execution supports configured OpenAI-compatible connections.

## Check changes

From the repository root:

```bash
bun test apps/web/lib/models/tests/unit
```

The tests use local data fixtures. Provider setup browser acceptance lives under
`apps/api/src/modules/models/tests/browser`; it uses deterministic responses rather
than sending real credentials to live providers.
