# Showing setup progress

After signing in, a user can see whether an account, provider and default model are
configured. For example, the progress card can offer “Connect a provider” when no
connection is saved. Loading that card must not run a model or probe a local service.

`setup-summary.ts` reads authenticated facts from `/api/instance/setup-summary` and
validates them before showing progress. It cancels obsolete requests and applies a
10-second deadline. An unreadable response is an error, not proof of an empty instance.
Connection health remains explicitly unchecked; configuration is not a live health test.

The role in this response controls which guidance the UI offers. The API still checks
actual permission for each operation. This summary cannot grant owner access or bypass
sign-in. Its returned object retains only the public facts needed by the screens.

From the repository root:

```bash
bun test apps/web/lib/onboarding/tests/unit
```

These tests check data projection and failure handling, not an actual provider setup.
