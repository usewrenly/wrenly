import { expect, test } from "bun:test";
import { createGitHubReadClient } from "../../src/providers/github/http-client";
test("GitHub GET pins origin and credentials without redirects or cookies", async () => {
  const client = createGitHubReadClient("test-token", async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/repos/team/studio");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-token" });
    return Response.json({ id: 42 });
  });
  expect(await client.get("/repos/team/studio")).toEqual({ id: 42 });
});
test("invalid selections fail before sending a credential", async () => {
  let calls = 0;
  const client = createGitHubReadClient("token", async () => {
    calls++;
    return Response.json({});
  });
  for (const path of [
    "https://evil.test",
    "//evil.test/repos/x/y",
    "/repos/../user",
    "/repos/%2e%2e/user",
    "/repos/a%2fb",
    "/repos/a/b#secret",
  ])
    await expect(client.get(path)).rejects.toThrow("invalid_request");
  expect(calls).toBe(0);
  expect(() => createGitHubReadClient("token\nvalue")).toThrow(
    "invalid_request",
  );
});
test("provider errors and excessive streamed bodies never expose remote content", async () => {
  const client = createGitHubReadClient(
    "token",
    async () => new Response("private remote data", { status: 403 }),
  );
  await expect(client.get("/user")).rejects.toThrow("http_error");
  const large = createGitHubReadClient(
    "token",
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  );
  await expect(large.get("/user")).rejects.toThrow("response_limit");
  const invalid = createGitHubReadClient(
    "token",
    async () => new Response("not-json"),
  );
  await expect(invalid.get("/user")).rejects.toThrow("invalid_json");
});
test("cancellation bounds a transport or body that ignores its signal", async () => {
  for (const transport of [
    async (): Promise<Response> => new Promise(() => {}),
    async (): Promise<Response> =>
      new Response(new ReadableStream({ start() {} })),
  ]) {
    const controller = new AbortController();
    const pending = createGitHubReadClient("token", transport).get(
      "/user",
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow("request_failed");
  }
});
