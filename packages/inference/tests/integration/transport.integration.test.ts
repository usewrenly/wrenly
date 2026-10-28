import { expect, test } from "bun:test";
import { createInferenceFetch } from "../../src/network/transport";
const integration =
  process.env.WRENLY_TEST_PROVIDER_PROBE === "true" ? test : test.skip;
integration(
  "real inference transport pins lookup, preserves model/token, sanitizes errors and refuses redirects",
  async () => {
    let host = "",
      token = "",
      model = "",
      redirectedCalls = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(): Response {
        redirectedCalls++;
        return Response.json({});
      },
    });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        host = request.headers.get("host") ?? "";
        token = request.headers.get("authorization") ?? "";
        const payload = (await request.json()) as { model: string };
        model = payload.model;
        if (model === "redirect")
          return Response.redirect(`${target.url.origin}/v1/chat/completions`);
        if (model === "denied")
          return Response.json(
            { error: { message: "fixture-secret-token echoed upstream" } },
            { status: 401 },
          );
        return Response.json({
          choices: [
            { message: { content: "fixture answer" }, finish_reason: "stop" },
          ],
        });
      },
    });
    try {
      const fetcher = createInferenceFetch(
        { baseUrl: `http://model.fixture:${server.port}/v1`, kind: "local" },
        async () => [{ address: "127.0.0.1", family: 4 }],
      );
      const invoke = (model: string): Promise<Response> =>
        fetcher(`http://model.fixture:${server.port}/v1/chat/completions`, {
          method: "POST",
          headers: { Authorization: "Bearer fixture-secret-token" },
          body: JSON.stringify({ model, stream: false }),
        });
      expect((await invoke("selected-model")).ok).toBe(true);
      expect(host).toBe(`model.fixture:${server.port}`);
      expect(token).toBe("Bearer fixture-secret-token");
      expect(model).toBe("selected-model");
      const denied = await invoke("denied");
      expect(denied.status).toBe(401);
      expect(await denied.text()).not.toContain("fixture-secret-token");
      await expect(invoke("redirect")).rejects.toThrow("redirected");
      expect(redirectedCalls).toBe(0);
    } finally {
      await server.stop(true);
      await target.stop(true);
    }
  },
);

integration(
  "inference bounds responses and cancels hanging requests and bodies",
  async () => {
    let cancelled = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const input = (await request.json()) as { model: string };
        if (input.model === "oversized")
          return new Response("x".repeat(8 * 1024 * 1024 + 1), {
            headers: { "Content-Type": "application/json" },
          });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    try {
      const baseUrl = `http://model.fixture:${server.port}/v1`;
      const resolver = async (): Promise<
        Array<{ address: string; family: number }>
      > => [{ address: "127.0.0.1", family: 4 }];
      const fetcher = createInferenceFetch(
        { baseUrl, kind: "local", timeoutMs: 200 },
        resolver,
      );
      const invoke = (model: string, signal?: AbortSignal): Promise<Response> =>
        fetcher(baseUrl + "/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model }),
          signal,
        });
      await expect(invoke("oversized")).rejects.toThrow("exceeds");
      await expect(invoke("slow")).rejects.toThrow("deadline");
      const deadline = Date.now() + 1000;
      while (!cancelled && Date.now() < deadline) await Bun.sleep(10);
      expect(cancelled).toBe(true);
      const controller = new AbortController();
      controller.abort();
      await expect(invoke("slow", controller.signal)).rejects.toThrow();
      let requestCancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          requestCancelled = true;
        },
      });
      await expect(
        fetcher(baseUrl + "/chat/completions", { method: "POST", body }),
      ).rejects.toThrow();
      expect(requestCancelled).toBe(true);
    } finally {
      await server.stop(true);
    }
  },
  5000,
);
