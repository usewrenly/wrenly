import { expect, test } from "bun:test";
import {
  parseProviderModels,
  readProviderModelList,
} from "../../transport/provider-probe";
test("local discovery differentiates empty installation from ready models and invalid lists", () => {
  expect(parseProviderModels({ models: [] }, "ollama")).toEqual({
    state: "empty",
    models: [],
  });
  expect(
    parseProviderModels({ models: [{ name: "installed:latest" }] }, "ollama"),
  ).toEqual({ state: "ready", models: ["installed:latest"] });
  expect(
    parseProviderModels({ data: [{ id: "served-model" }] }, "openai-compatible")
      .models,
  ).toEqual(["served-model"]);
  expect(() =>
    parseProviderModels({ models: [{ id: "wrong-field" }] }, "ollama"),
  ).toThrow("invalid model");
});
const integration =
  process.env.WRENLY_TEST_PROVIDER_PROBE === "true" ? test : test.skip;
integration(
  "real HTTP probe pins checked DNS and refuses redirects without forwarding credentials",
  async () => {
    let observedHost = "",
      observedToken = "",
      redirectedCalls = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(): Response {
        redirectedCalls++;
        return Response.json({ data: [] });
      },
    });
    const source = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request): Response {
        observedHost = request.headers.get("host") ?? "";
        observedToken = request.headers.get("authorization") ?? "";
        const path = new URL(request.url).pathname;
        if (path === "/authentication/models")
          return Response.json(
            { private: "upstream details" },
            { status: 401 },
          );
        if (path === "/large/models")
          return new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
            headers: { "Content-Type": "application/json" },
          });
        if (path === "/malformed/models")
          return new Response("not-json", {
            headers: { "Content-Type": "application/json" },
          });
        if (path === "/redirect/models")
          return Response.redirect(`${target.url.origin}/models`);
        return Response.json({ data: [{ id: "fixture-model" }] });
      },
    });
    try {
      const endpoint = `http://provider.fixture:${source.port}`;
      const resolver = async (): Promise<
        Array<{ address: string; family: number }>
      > => [{ address: "127.0.0.1", family: 4 }];
      expect(
        parseProviderModels(
          await readProviderModelList(
            {
              endpoint,
              protocol: "openai-compatible",
              kind: "local",
              token: "fixture-token",
            },
            undefined,
            resolver,
          ),
          "openai-compatible",
        ).models,
      ).toEqual(["fixture-model"]);
      expect(observedHost).toBe(`provider.fixture:${source.port}`);
      expect(observedToken).toBe("Bearer fixture-token");
      await expect(
        readProviderModelList(
          {
            endpoint: endpoint + "/redirect",
            protocol: "openai-compatible",
            kind: "local",
            token: "fixture-token",
          },
          undefined,
          resolver,
        ),
      ).rejects.toThrow("redirected");
      expect(redirectedCalls).toBe(0);
      for (const [suffix, message] of [
        ["authentication", "rejected this token"],
        ["large", "exceeds"],
        ["malformed", "could not be read"],
      ] as const)
        await expect(
          readProviderModelList(
            {
              endpoint: endpoint + "/" + suffix,
              protocol: "openai-compatible",
              kind: "local",
              token: "fixture-token",
            },
            undefined,
            resolver,
          ),
        ).rejects.toThrow(message);
      await expect(
        readProviderModelList(
          {
            endpoint,
            protocol: "openai-compatible",
            kind: "local",
            token: "fixture-token",
          },
          AbortSignal.abort(),
          resolver,
        ),
      ).rejects.toThrow("cancelled");
      await expect(
        readProviderModelList(
          {
            endpoint,
            protocol: "openai-compatible",
            kind: "cloud",
            token: "fixture-token",
          },
          undefined,
          resolver,
        ),
      ).rejects.toThrow("HTTPS");
    } finally {
      await source.stop(true);
      await target.stop(true);
    }
  },
);
