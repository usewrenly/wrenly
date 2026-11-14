import { expect, test } from "bun:test";
import { resolveAttachmentContent } from "../resolve-content";
import type { AttachmentObjectStore } from "../storage/object-store";
import type { AttachmentSnapshot } from "@wrenly/inference";
test("saved reference resolution preserves order and refuses a missing object without substituting", async () => {
  const files: AttachmentSnapshot = {
    version: 1,
    files: [0, 1].map(() => ({
      id: crypto.randomUUID(),
      objectId: crypto.randomUUID(),
      name: "reference.txt",
      mediaType: "text/plain",
      byteLength: 1,
      sha256: "a".repeat(64),
    })),
  };
  const calls: string[] = [];
  const objects: AttachmentObjectStore = {
    write: async () => {
      throw new Error("No writes during execution");
    },
    remove: async () => {
      throw new Error("No deletion during execution");
    },
    read: async (object) => {
      calls.push(object.id);
      return new Uint8Array([65]);
    },
  };
  expect((await resolveAttachmentContent(objects, files)).length).toBe(2);
  expect(calls).toEqual(files.files.map((file) => file.objectId));
  objects.read = async () => {
    throw new Error("Missing");
  };
  await expect(resolveAttachmentContent(objects, files)).rejects.toThrow(
    "Missing",
  );
  expect(await resolveAttachmentContent(objects, undefined)).toEqual([]);
});
