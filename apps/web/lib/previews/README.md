# Checking preview navigation links

When the API grants access to a ready booking-app preview, the browser receives a
link to the isolated preview gateway. `access-url.ts` checks that this is an absolute
HTTP(S) link without embedded credentials before putting it into a frame or new tab.
Executable schemes such as `javascript:` are rejected.

This check does not grant preview permission or choose an allowed preview host. The
API/gateway still verify the session, selected revision and one-time access grant.
Model browsing and external-media permissions remain separate capabilities.

`hooks/use-local-preview.ts` owns polling, explicit prepare/stop/open actions and stale
response cancellation. Reads have deadlines and bypass caches. Stopping another
preview waits for cleanup before preparing the selected revision; viewing a project
alone does not execute generated source in the browser.

```bash
bun test apps/web/lib/previews/tests/unit
```

`contracts.ts` owns the validated preview snapshot and its TypeScript type. Known
lifecycle states, an explicit nullable error and a boolean cleanup flag are required.
A missing flag is not confirmation that runtime cleanup finished.
