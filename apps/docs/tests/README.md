# Documentation checks

Unit tests cover community-link validation. `docs:check` validates public guide links
and the boundary between public content and developer-only files. Neither starts an
instance or calls a model.

After building the docs app, run these opt-in checks from the repository root:

```bash
WRENLY_TEST_PUBLIC_DOCS=true bun test apps/docs/tests/integration/public-handbook.integration.test.ts
WRENLY_TEST_DOCS_BROWSER=true bun test apps/docs/tests/browser/documentation-browser.integration.test.ts
```

The first check starts the built server on loopback, checks routes/search and shuts it
down. The browser check also needs local Google Chrome and uses an isolated profile.
Fixtures use local services only; they do not query accounts, generated applications or
operator storage. A skipped test is not an acceptance result.
