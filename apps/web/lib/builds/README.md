# Following a build in the browser

When you ask Wrenly to build a booking app, the API saves the request and executes
it. This folder helps the browser display that work. Refreshing the page must
show the saved result rather than start another booking-app build.

A **snapshot** is the saved build state at one moment. Its **cursor** is the number
of the latest saved progress event included in that state. The browser first reads
both together, then asks for events after that number. This avoids missing progress
between loading the page and connecting to updates.

## Responsibilities

- `durable-build-client.ts` submits requests and follows one saved build. Submission
  retries reuse an **idempotency key**: an identifier allowing the API to recognize
  the same request even if its first acknowledgement was lost. Reconnection only
  reads state/events; it never submits another request.
- `build-events.ts` reads server-sent events, the HTTP stream carrying progress.
  Network chunks may split lines or characters. A disconnected stream is not proof
  that the build succeeded: a confirmed completion event is required.
- `build-state.ts` turns validated events and saved history into workspace state.
  Failed builds retain generated files and errors so people can inspect them.
- `build-activity.ts` validates reported execution steps such as installation and
  validation. These are actual operation reports, not private model reasoning.
- `tests/unit` checks parsing, state restoration, replay identity and reconnects.

The React hook in `hooks/use-build-stream.ts` connects these functions to the UI.
The API owns permissions, execution and persisted history. Cancelling browser
observation does not cancel the server's build; stopping that build requires the
separate authenticated cancellation request.

## Check changes

From the repository root:

```bash
bun test apps/web/lib/builds/tests/unit
```

These tests use local response fixtures, with no model calls or Docker builds.
They do not replace database execution or full browser acceptance tests.
