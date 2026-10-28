import { expect, test } from "bun:test";
import { readProjectInput } from "../../http/project-input";

function request(body: string, type = "application/json"): Request {
  return new Request("http://fixture.test", {
    method: "POST",
    headers: { "Content-Type": type },
    body,
  });
}

test("project input parses bounded JSON and rejects invalid input without raw contents", async () => {
  expect(await readProjectInput(request('{"name":"Notes"}'))).toEqual({
    name: "Notes",
  });
  await expect(
    readProjectInput(request("secret malformed data")),
  ).rejects.toThrow("Project details must be valid JSON.");
  await expect(
    readProjectInput(request("{}", "text/plain")),
  ).rejects.toMatchObject({ status: 415 });
});

test("project input bounds streamed bytes and cancels oversized input", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8193));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readProjectInput(
      new Request("http://fixture.test", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": "1" },
        body,
      }),
    ),
  ).rejects.toMatchObject({ status: 413 });
  expect(cancelled).toBe(true);
});

test("stalled project input times out and cancels its stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    readProjectInput(
      new Request("http://fixture.test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }),
    ),
  ).rejects.toMatchObject({ status: 408 });
  expect(cancelled).toBe(true);
}, 8000);
