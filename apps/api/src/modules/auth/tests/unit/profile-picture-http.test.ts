// Boundary tests use injected persistence, never the operator database.
import { describe, expect, test } from "bun:test";
import { createProfilePictureHandlers } from "../../profile/pictures/profile-picture-http";
import {
  MAX_PICTURE_INPUT_BYTES,
  ProfilePictureError,
} from "../../profile/pictures/profile-picture-policy";
const mutationId = crypto.randomUUID();
const metadata = {
  userId: "account",
  revision: null,
  mutationId: null,
  url: null,
};
function fixture() {
  const calls: string[] = [];
  const handlers = createProfilePictureHandlers({
    webUrl: "http://localhost:3000",
    session: async (h) =>
      h.get("authorization") === "fixture" ? "account" : null,
    metadata: async () => metadata,
    image: async (actor, target) => {
      calls.push("image");
      if (actor !== target)
        throw new ProfilePictureError(404, "Picture unavailable.");
      return new Uint8Array([1, 2]);
    },
    decode: async (bytes) => {
      calls.push("decode");
      return bytes;
    },
    save: async (actor, input, bytes) => {
      calls.push(bytes ? "save" : "remove");
      return { ...metadata, userId: actor, mutationId: input.mutationId };
    },
  });
  const request = (
    method = "PUT",
    body?: Uint8Array,
    headers: Record<string, string> = {},
  ) =>
    new Request("http://localhost:3002/api/account/profile-picture", {
      method,
      headers: {
        authorization: "fixture",
        origin: "http://localhost:3000",
        "content-type": "image/png",
        "idempotency-key": mutationId,
        ...headers,
      },
      body: body ? Buffer.from(body) : undefined,
    });
  return { handlers, calls, request };
}
describe("profile picture HTTP boundary", () => {
  test("session and origin checks precede decoder and persistence", async () => {
    const f = fixture();
    expect(
      (
        await f.handlers.save(
          f.request("PUT", new Uint8Array([1]), { authorization: "" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.handlers.save(
          f.request("PUT", new Uint8Array([1]), {
            origin: "https://outside.test",
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.handlers.save(
          f.request("PUT", new Uint8Array([1]), { origin: "" }),
        )
      ).status,
    ).toBe(403);
    expect(f.calls).toEqual([]);
  });
  test("streams actual byte limits and rejects bad formats/identities before decoding", async () => {
    const f = fixture();
    expect(
      (
        await f.handlers.save(
          f.request("PUT", new Uint8Array(MAX_PICTURE_INPUT_BYTES + 1)),
        )
      ).status,
    ).toBe(413);
    expect(
      (
        await f.handlers.save(
          f.request("PUT", new Uint8Array([1]), {
            "content-type": "image/svg+xml",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.handlers.save(
          f.request("PUT", new Uint8Array([1]), { "idempotency-key": "wrong" }),
        )
      ).status,
    ).toBe(400);
    expect(f.calls).toEqual([]);
  });
  test("metadata, upload, removal and canonical retrieval retain private response headers", async () => {
    const f = fixture();
    expect(
      (await f.handlers.metadata(f.request("GET"))).headers.get(
        "cache-control",
      ),
    ).toContain("no-store");
    expect(
      (await f.handlers.save(f.request("PUT", new Uint8Array([1])))).status,
    ).toBe(200);
    expect((await f.handlers.remove(f.request("DELETE"))).status).toBe(200);
    const image = await f.handlers.image(
      new Request(
        `http://localhost:3002/api/account/profile-picture/image?userId=account&revision=${mutationId}`,
        { headers: { authorization: "fixture" } },
      ),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("cross-origin-resource-policy")).toBe(
      "same-origin",
    );
    expect(f.calls).toEqual(["decode", "save", "remove", "image"]);
  });
  test("a held decoder blocks concurrent buffering and releases admission after failure", async () => {
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handlers = createProfilePictureHandlers({
      webUrl: "http://localhost:3000",
      session: async () => "account",
      metadata: async () => metadata,
      image: async () => new Uint8Array(),
      decode: async () => {
        await waiting;
        throw new Error("fixture failure");
      },
      save: async () => metadata,
    });
    const f = fixture();
    const first = handlers.save(f.request("PUT", new Uint8Array([1])));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      (await handlers.save(f.request("PUT", new Uint8Array([1])))).status,
    ).toBe(503);
    release?.();
    expect((await first).status).toBe(503);
    expect(
      (await handlers.save(f.request("PUT", new Uint8Array([1])))).status,
    ).toBe(503);
  });
});
