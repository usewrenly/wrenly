import { expect, test } from "bun:test";
import { createPreviewGateway } from "../../gateway/preview-gateway";
const ID = "101e4567-e89b-12d3-a456-426614174007";
const ORIGIN = `http://${ID}.wrenly-preview.localhost:3003`;
function fixture(): {
  handler: ReturnType<typeof createPreviewGateway>;
  consumed: () => number;
} {
  let consumed = 0;
  return {
    consumed: () => consumed,
    handler: createPreviewGateway({
      baseUrl: "http://wrenly-preview.localhost:3003",
      controlOrigin: "http://localhost:3000",
      consume: async () => {
        consumed++;
        return "b".repeat(64);
      },
      authorize: async () => null,
      touch: async () => false,
      runtime: () => null,
    }),
  };
}
test("gateway rejects unknown hosts and foreign bootstrap origins before grant consumption", async () => {
  const f = fixture();
  expect((await f.handler(new Request("http://localhost:3003/"))).status).toBe(
    404,
  );
  expect(
    (
      await f.handler(
        new Request(ORIGIN + "/__wrenly/access", {
          method: "POST",
          headers: { origin: "http://attacker.localhost" },
          body: "{}",
        }),
      )
    ).status,
  ).toBe(403);
  expect(f.consumed()).toBe(0);
});
test("gateway bounds chunked bootstrap bodies and never exposes generated content anonymously", async () => {
  const f = fixture();
  expect(
    (
      await f.handler(
        new Request(ORIGIN + "/__wrenly/access", {
          method: "POST",
          headers: { origin: ORIGIN },
          body: "x".repeat(1025),
        }),
      )
    ).status,
  ).toBe(413);
  expect((await f.handler(new Request(ORIGIN + "/"))).status).toBe(401);
  expect(f.consumed()).toBe(0);
});
test("trusted bootstrap clears fragment before contacting access endpoint and never reflects the grant", async () => {
  const f = fixture();
  const response = await f.handler(
    new Request(ORIGIN + "/__wrenly/bootstrap#secret-not-for-app"),
  );
  const html = await response.text();
  expect(html).not.toContain("secret-not-for-app");
  expect(html.indexOf("history.replaceState")).toBeLessThan(
    html.indexOf("fetch('/__wrenly/access'"),
  );
  expect(response.headers.get("content-security-policy")).toContain(
    "frame-ancestors http://localhost:3000",
  );
  expect(response.headers.get("cache-control")).toBe("no-store");
});
test("successful bootstrap issues only a host-only secure HttpOnly session cookie", async () => {
  const f = fixture();
  const response = await f.handler(
    new Request(ORIGIN + "/__wrenly/access", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ grant: "a".repeat(64) }),
    }),
  );
  expect(response.status).toBe(204);
  const cookie = response.headers.getSetCookie()[0]!;
  expect(cookie).toContain("__Host-wrenly-preview=");
  expect(cookie).toContain("Partitioned");
  expect(cookie).toContain("HttpOnly; Secure; SameSite=None");
  expect(cookie.toLowerCase()).not.toContain("domain=");
});

test("authorized media hosts affect images/media only and cannot override the preview boundary", async () => {
  const handler = createPreviewGateway({
    baseUrl: "http://wrenly-preview.localhost:3003",
    controlOrigin: "http://localhost:3000",
    consume: async () => null,
    authorize: async () => "viewer",
    touch: async () => true,
    runtime: () => ({
      ingressUrl: "http://127.0.0.1:39999",
      capability: "c".repeat(64),
    }),
    mediaOrigins: async () => ["https://images.unsplash.com"],
    fetch: Object.assign(
      async () =>
        new Response("fixture", {
          headers: { "content-security-policy": "default-src *" },
        }),
      { preconnect: fetch.preconnect },
    ),
  });
  const response = await handler(new Request(ORIGIN + "/"));
  expect(response.status).toBe(200);
  const csp = response.headers.get("content-security-policy")!;
  expect(csp).toContain(
    "img-src 'self' data: blob: https://images.unsplash.com",
  );
  expect(csp).toContain(
    "media-src 'self' data: blob: https://images.unsplash.com",
  );
  expect(csp).toContain("connect-src 'self';");
  expect(csp).toContain("script-src 'self' 'unsafe-inline';");
  expect(csp).toContain("frame-src 'none';");
  expect(csp).not.toContain("default-src *");
  expect(await response.text()).toBe("fixture");
});

// A complete JSON prefix is not a complete request until the stream finishes.
test("bootstrap deadline never consumes a grant from an unfinished request", async () => {
  const f = fixture();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode(JSON.stringify({ grant: "a".repeat(64) })));
  } });
  const response = await f.handler(new Request(ORIGIN + "/__wrenly/access", {
    method: "POST", headers: { origin: ORIGIN }, body,
  }));
  expect(response.status).toBe(408);
  expect(f.consumed()).toBe(0);
}, 8000);
