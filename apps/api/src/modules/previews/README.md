# Opening a saved app in the browser

You finish a build and select Preview. Wrenly prepares that saved revision in Docker,
then gives your browser permission to view it. **A preview is a temporary running app,
not a deployment.** Refreshing the workspace reads its saved state instead of starting
another build or preview automatically.

## Two trusted forwarding steps

The browser opens a separate preview origin. The **gateway** checks the viewer's current
access before forwarding a request. It sends that request to an **ingress**: a small
trusted proxy connected to exactly one isolated app container. Neither step lets the
browser or model choose an arbitrary destination.

`gateway/preview-gateway.ts` handles browser access and protected response headers.
`gateway/preview-ingress.ts` strips control credentials, checks the gateway's private
capability and forwards only to the verified app. This file is also bundled separately
for Docker; its build path in package.json must move with it.

The initial link contains a short-lived, single-use grant in its URL fragment. The
bootstrap page removes that fragment before contacting the access endpoint. The grant
becomes a host-only, Secure, HttpOnly viewer cookie. Production requests recheck the
control session, project access revision, preview readiness and expiry; knowing a
preview hostname alone does not grant access. Grant/session tokens are stored as hashes.
There is no sessionless helper mode. Historical grants missing their control-session
binding are rejected; sign in and reopen the preview from Wrenly to obtain a new link.

An **access revision** changes when project policy changes. Previously issued preview
access tied to the old policy stops authorizing new requests. Already delivered pages
or approved remote media may remain in an open browser; permission changes cannot
recall data the browser already received.

## Finding the other responsibilities

- `access/preview-access.ts` issues/consumes grants and checks persisted viewer access.
- `persistence/preview-store.ts` owns admission, claims, leases, status and cleanup/recovery records.
- `execution/preview-worker.ts` and its service/production adapters execute the saved lifecycle.
- `execution/preview-executor-lock.ts` prevents overlapping execution during recovery.
- `media/` validate and save exact owner-approved image/video origins.
- `http/http.ts` exposes the authenticated control operations.
- `tests/unit` checks worker ownership, media validation and gateway/ingress forwarding.
- `tests/integration` checks real kernel locks and release after parent-process death.
- `tests/browser` exercises the workspace, media controls and browser cookie/frame boundary.

The worker's **claim** identifies the execution allowed to change its saved status.
Its **lease** expires unless renewed. Interruption requires cleanup/recovery; observing
a preview or reconnecting a browser does not authorize repeating uncertain work.

## Checking the forwarding boundary

From the repository root:

```bash
bun test apps/api/src/modules/previews/tests/unit
bun run --cwd apps/api check-types
bun run --cwd apps/api lint
bun run --cwd apps/api build
```

These unit checks use controlled requests and fake upstreams. Docker runtime, database
transactions and browser acceptance have separate integration fixtures; passing unit
checks alone does not establish those boundaries. The public local-preview guide lives
in `apps/docs/content/docs/guides/local-previews.mdx`.

## Checking persistence and recovery

`packages/db/tests/integration/resources/preview-store.integration.test.ts` uses an explicitly selected
throwaway PostgreSQL database. It checks that duplicate requests share one saved
preview, stale workers cannot publish success, and failed cleanup keeps its capacity
reservation. With `WRENLY_TEST_DOCKER=true`, it also starts controlled app containers
and the packaged API, signs in through Better Auth, then checks crash/shutdown cleanup.
Never point this fixture at your working database; its URL guard requires a local
`wrenly_preview_test` database.

Kernel-lock checks need `WRENLY_TEST_MCP=true`; browser checks need
`WRENLY_TEST_PREVIEW_BROWSER=true` and local Chrome. They contact only controlled local
fixture servers. No model provider or deployment is needed for these checks.

## Database-backed preview preparation remains internal

The normal HTTP/worker path still refuses database source. An explicit internal
`admitDatabasePreview` path now saves validated code/Development-schema evidence with
its reservation. The separate database claim checks that evidence and the original
submitting contributor again; the ordinary worker skips those reservations. Live socket
access and runtime cleanup are not connected yet, so this does not enable the feature.
See the database module's `bindings/README.md` for the saved revision and replay rules.
