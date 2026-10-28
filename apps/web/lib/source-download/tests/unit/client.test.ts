import { expect, test } from "bun:test";
import { loadSourceDownload } from "../../client";
const id = "f0806312-6585-4b70-9e9b-1e39fd21b017";
function snapshot(outcome = "success"): object {
  return {
    cursor: 1,
    outcome,
    executionSecret: "must-not-export",
    build: {
      id,
      status: outcome === "success" ? "success" : "failed",
      attemptCount: 1,
      buildLog: "not-source",
      errorMessage: null,
      deployedUrl: null,
      files: [{ path: "index.txt", content: "saved-source" }],
    },
  };
}
test("export rechecks the exact revision without cache and excludes job/log metadata", async () => {
  const calls: string[] = [];
  const bytes = await loadSourceDownload(
    id,
    async (path, options) => {
      calls.push(path);
      expect(options?.cache).toBe("no-store");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return Response.json(snapshot("failed"));
    },
    new AbortController().signal,
  );
  expect(calls).toEqual([`/api/builds/${id}`]);
  const text = new TextDecoder().decode(bytes);
  expect(text).toContain("saved-source");
  expect(text).not.toContain("must-not-export");
  expect(text).not.toContain("not-source");
});
test("denied, running and substituted snapshots never fall back to locally visible source", async () => {
  for (const status of [401, 403, 404, 503])
    await expect(
      loadSourceDownload(
        id,
        async () => new Response(null, { status }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  await expect(
    loadSourceDownload(
      id,
      async () => Response.json(snapshot("running")),
      new AbortController().signal,
    ),
  ).rejects.toThrow("finish");
  const substituted = snapshot() as { build: { id: string } };
  substituted.build.id = crypto.randomUUID();
  await expect(
    loadSourceDownload(
      id,
      async () => Response.json(substituted),
      new AbortController().signal,
    ),
  ).rejects.toThrow("does not match");
  const controller = new AbortController();
  controller.abort();
  await expect(
    loadSourceDownload(
      id,
      async () => Response.json(snapshot()),
      controller.signal,
    ),
  ).rejects.toThrow();
});

test("oversized response cancels its reader before parsing or exporting", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller): void { controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1)); },
    cancel(): void { cancelled = true; },
  });
  await expect(loadSourceDownload(id, async () => new Response(body), new AbortController().signal))
    .rejects.toThrow("too large");
  expect(cancelled).toBe(true);
});

test("cancellation prevents archive creation even when a complete response body is available", async () => {
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(stream): void {
      stream.enqueue(new TextEncoder().encode(JSON.stringify(snapshot())));
      stream.close();
    },
  });
  await expect(loadSourceDownload(id, async () => {
    controller.abort(new Error('Selected revision changed'));
    return new Response(body);
  }, controller.signal)).rejects.toThrow('Selected revision changed');
});
