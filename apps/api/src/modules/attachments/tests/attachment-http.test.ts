import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  createAttachmentHttpHandlers,
  type AttachmentHttpDependencies,
} from "../attachment-http";
import type { AttachmentReference } from "@wrenly/inference";
function fixture() {
  const bytes = new TextEncoder().encode("Design reference");
  const object = {
    id: crypto.randomUUID(),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
  const file: AttachmentReference = {
    id: crypto.randomUUID(),
    objectId: object.id,
    sha256: object.sha256,
    byteLength: object.byteLength,
    name: "reference.txt",
    mediaType: "text/plain",
  };
  let saves = 0;
  const dependencies: AttachmentHttpDependencies = {
    webUrl: "http://localhost:3000",
    userId: async () => "actor",
    objects: {
      write: async () => object,
      read: async () => bytes,
      remove: async () => {},
    },
    decodeImage: async () => {
      throw new Error("Text should not call decoder");
    },
    save: async () => {
      saves++;
      return { file, replayed: false };
    },
    read: async () => file,
    complete: async () => file,
    findUpload: async () => file,
    remove: async () => {},
  };
  return { dependencies, saves: () => saves };
}
function request(
  body = "Design reference",
  origin = "http://localhost:3000",
): Request {
  return new Request(
    "http://localhost:3002/api/attachments?name=reference.txt",
    {
      method: "POST",
      body,
      headers: {
        origin,
        "idempotency-key": crypto.randomUUID(),
        "content-type": "application/octet-stream",
      },
    },
  );
}
test("authenticates before reading or saving upload and enforces exact origin", async () => {
  const state = fixture();
  const handlers = createAttachmentHttpHandlers(state.dependencies);
  expect(
    (await handlers.upload(request("text", "https://elsewhere.example")))
      .status,
  ).toBe(403);
  state.dependencies.userId = async () => null;
  expect((await handlers.upload(request())).status).toBe(401);
  expect(state.saves()).toBe(0);
});
test("saves text without exposing private object identity", async () => {
  const state = fixture();
  const response = await createAttachmentHttpHandlers(
    state.dependencies,
  ).upload(request());
  expect(response.status).toBe(201);
  const result = (await response.json()) as { file: Record<string, unknown> };
  expect(result.file.name).toBe("reference.txt");
  expect(result.file.objectId).toBeUndefined();
  expect(state.saves()).toBe(1);
});
test("binary documents are rejected before persistence and reads are never cacheable", async () => {
  const state = fixture();
  const handlers = createAttachmentHttpHandlers(state.dependencies);
  expect((await handlers.upload(request("a\0b"))).status).toBe(400);
  expect(state.saves()).toBe(0);
  const response = await handlers.read(
    new Request("http://localhost:3002/api/attachments/id"),
    crypto.randomUUID(),
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
});

test("an uncertain upload can recover its acknowledgement without another file write", async () => {
  const state = fixture();
  state.dependencies.objects.write = async () => {
    throw new Error("Status must not write");
  };
  const handlers = createAttachmentHttpHandlers(state.dependencies);
  const response = await handlers.uploadStatus(
    new Request("http://localhost:3002/api/attachments/uploads/id"),
    crypto.randomUUID(),
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { file: Record<string, unknown> };
  expect(body.file.name).toBe("reference.txt");
  expect(body.file.objectId).toBeUndefined();
  expect(state.saves()).toBe(0);
});

test("reserves ownership before writing bytes and acknowledges only verified completion", async () => {
  const state = fixture();
  const events: string[] = [];
  const save = state.dependencies.save;
  const write = state.dependencies.objects.write;
  const read = state.dependencies.objects.read;
  const complete = state.dependencies.complete;
  state.dependencies.save = async (...args) => {
    events.push("reserve");
    return save(...args);
  };
  state.dependencies.objects.write = async (...args) => {
    events.push("write");
    return write(...args);
  };
  state.dependencies.objects.read = async (...args) => {
    events.push("verify");
    return read(...args);
  };
  state.dependencies.complete = async (...args) => {
    events.push("complete");
    return complete(...args);
  };
  expect(
    (await createAttachmentHttpHandlers(state.dependencies).upload(request()))
      .status,
  ).toBe(201);
  expect(events).toEqual(["reserve", "write", "verify", "complete"]);
  events.length = 0;
  state.dependencies.save = async () => {
    throw new Error("Unknown reservation outcome");
  };
  expect(
    (await createAttachmentHttpHandlers(state.dependencies).upload(request()))
      .status,
  ).toBe(503);
  expect(events).toEqual([]);
});
