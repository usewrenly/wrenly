import { expect, test } from "bun:test";
import { createInstanceAccessHandler } from "../../access/instance-access";
test("single-user installations still require a verified session", async () => {
  for (const id of [null, "owner"]) {
    const handler = createInstanceAccessHandler({
      singleUser: true,
      userId: async () => id,
    });
    const response = await handler(
      new Request("http://api.test/api/instance/access"),
    );
    expect(await response.json()).toEqual({
      mode: "single-user",
      access: id ? "authenticated" : "sign-in-required",
    });
    expect(response.headers.get("cache-control")).toContain("no-store");
  }
});
test("multi-user access validates incoming session and never exposes identity or credentials", async () => {
  for (const id of [null, "private-user-id"]) {
    const handler = createInstanceAccessHandler({
      singleUser: false,
      userId: async (headers) => {
        expect(headers.get("cookie")).toBe("session=fixture");
        return id;
      },
    });
    const response = await handler(
      new Request("http://api.test", {
        headers: { Cookie: "session=fixture" },
      }),
    );
    expect(await response.json()).toEqual({
      mode: "multi-user",
      access: id ? "authenticated" : "sign-in-required",
    });
  }
});
test("auth service failure is unavailable rather than a local access fallback", async () => {
  const handler = createInstanceAccessHandler({
    singleUser: false,
    userId: async () => {
      throw new Error("private provider diagnostic");
    },
  });
  const response = await handler(new Request("http://api.test"));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private provider diagnostic");
});
