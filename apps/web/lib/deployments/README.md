# Preserving publishing request identity

If the browser loses a publishing response, the app may already be deploying. The
browser must retry that same request rather than create another deployment. An
**idempotency key** is the identifier the API uses to recognize the same request.

`publishing-key.ts` validates and persists that key before the publishing POST. An
unreadable, corrupted or unwritable browser record blocks submission with a storage
message. Allow site storage and reload to recover; a storage failure must not silently
become a new publishing request. The key is not a deployment credential.

`hooks/use-deployment.ts` observes one selected revision, retains acknowledgement
identity, polls without caching and ignores late responses from prior selections.
Known terminal acknowledgements can release their browser key. Uncertain operations
retain it. Cancelling queued work is an explicit API action; observing status never
starts another deployment. The API remains authoritative for project ownership,
readiness, execution and reconciliation.

```bash
bun test apps/web/lib/deployments/tests/unit
```

The local Chrome fixture checks remount/revision races and blocked storage without
sending anything to a real registry or deployment provider.

`contracts.ts` owns the validated publishing snapshot and TypeScript type. It requires
a recognized lifecycle state, the selected build ID and explicit nullable URL/error
fields. Only HTTP(S) URLs without embedded credentials can become app links.
