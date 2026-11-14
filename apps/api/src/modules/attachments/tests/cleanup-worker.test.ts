import { expect, test } from "bun:test";
import { cleanupAttachmentPage } from "../cleanup-worker";
test("cleanup advances only through durable tombstones and retries the same page on failure", async () => {
  const order: string[] = [];
  const dependencies = {
    expire: async () => {
      order.push("expire");
    },
    candidates: async (cursor?: string) => {
      order.push(cursor ?? "start");
      return [{ id: "row", objectId: "object" }];
    },
    remove: async (id: string) => {
      order.push(id);
    },
  };
  expect(await cleanupAttachmentPage(dependencies)).toBe("row");
  expect(order).toEqual(["expire", "start", "object"]);
  dependencies.remove = async () => {
    throw new Error("Unavailable");
  };
  await expect(
    cleanupAttachmentPage(dependencies, "previous"),
  ).rejects.toThrow();
});
