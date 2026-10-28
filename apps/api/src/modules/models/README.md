# Choosing and connecting AI models

A **model** produces an answer from instructions. A **provider** runs the service you
ask for that answer. Ollama can run models locally; a hosted provider runs them on its
own servers. A provider **token** is the secret used to access that service.

For example:

> The instance owner connects a provider → chooses a default model → a user sends a
> prompt → Wrenly asks that model for an answer, without revealing the token to the browser.

## Find the code

```text
catalog/          Searchable public provider/model descriptions and offline copy
configuration/    Owner settings, connection saves and instance defaults
credentials/      Encrypts tokens and protects the instance encryption key
environment/      Reads explicit server configuration and supports reviewed import
selection/        Remembers which connection/model each submitted request chose
discovery/        Checks models listed by services actually configured here
transport/        Sends read-only checks using the shared safe-address rules
tests/unit/       Rules and controlled service checks
tests/browser/    Dashboard connection/model workflow
```

## A catalog entry is not a connection

The Models.dev **catalog** describes available providers and models. Searching it
requires no provider token. Wrenly bundles a licensed offline copy; only an explicit
owner refresh fetches new public metadata.

A saved **connection** contains the reviewed server address and encrypted credentials.
Catalog updates never change that address or redirect its token. Registry package
names are descriptions, not permission to install or run code. Some listed providers
need adapters that Wrenly does not support yet.

**Discovery** asks a configured service which models it lists. A catalog model is not
proof that it is installed locally or available to your account. An unreachable service
gets an honest unavailable state rather than silently changing the selection.

## Keep secrets and queued work predictable

Only the instance owner manages shared connections. The browser sees safe metadata;
tokens are decrypted only on the server when needed. The private encryption key must
be included in instance backups. If it is lost, Wrenly refuses to generate a replacement
over existing encrypted tokens because the replacement could not decrypt them.

When a request is submitted, Wrenly saves its connection version and model ID. That is
a **frozen selection**: later default changes cannot send queued work to another service.
Disabled, changed or missing connections fail explicitly. Importing environment settings
does not leave an old provider ID available to bypass a disabled saved connection.

## Check the address before sending a token

An **endpoint** is the provider URL. Shared inference rules check its resolved network
addresses and distinguish local servers from hosted services. Checks use the address
that was validated and refuse redirects. This prevents a token from being forwarded
to an unexpected server. See `packages/inference/README.md` for that connection flow.

Types have one owning definition: catalog schemas describe catalog data, connection
storage describes safe connection metadata, and selection describes saved choices.
Import them rather than copying their fields. Never return `ProviderDef.apiKey` or a
decrypted connection object as browser metadata.

## Check a change

```bash
bun test apps/api/src/modules/models/tests/unit
bun run --cwd apps/api check-types
```

Optional HTTP checks use local fake services. Database tests use only the dedicated
`wrenly_provider_test`; browser tests use fake tokens. They do not prove a real provider
account can run a model. `bun run catalog:snapshot` deliberately updates bundled source
data; it is a contributor action, never part of tests or normal startup.
