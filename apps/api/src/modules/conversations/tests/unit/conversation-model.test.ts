import { describe, expect, test } from "bun:test";
import { inferConversationDecision } from "../../execution/conversation-model";
import type { ConversationContext } from "../../execution/conversation-context";

const context: ConversationContext = {
  project: { name: "Fixture", stack: "nextjs" },
  messages: [{ role: "user", content: "Why did it fail?" }],
  revision: null,
};
const provider = {
  baseUrl: "http://provider.test/v1/",
  apiKey: "server-only-secret",
};
function response(content: unknown, finish = "stop"): Response {
  return Response.json({
    choices: [
      { finish_reason: finish, message: { content: JSON.stringify(content) } },
    ],
  });
}
function transport(
  operation: (request: Request) => Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (url: Parameters<typeof fetch>[0], init?: RequestInit) =>
      operation(new Request(url, init)),
    { preconnect: fetch.preconnect },
  ) as typeof fetch;
}
const input = { context, model: "selected-model", mode: "ask" as const };

describe("bounded conversation inference", () => {
  test("uses the selected server provider/model, JSON output and redirect rejection without tool execution", async () => {
    let calls = 0;
    const result = await inferConversationDecision(
      input,
      provider,
      new AbortController().signal,
      transport(async (request) => {
        calls++;
        expect(request.url).toBe("http://provider.test/v1/chat/completions");
        expect(request.redirect).toBe("error");
        expect(request.headers.get("authorization")).toBe(
          "Bearer server-only-secret",
        );
        const body = (await request.json()) as {
          model: string;
          stream: boolean;
          tools?: unknown;
          messages: Array<{ content: string }>;
        };
        expect(body.model).toBe("selected-model");
        expect(body.stream).toBe(false);
        expect(body.tools).toBeUndefined();
        expect(body.messages[1]?.content).not.toContain("server-only-secret");
        return response({
          type: "clarify",
          content: "Which revision should I inspect?",
        });
      }),
    );
    expect(result.type).toBe("clarify");
    expect(calls).toBe(1);
  });
  test("provider rejection is sanitized and never retried", async () => {
    let calls = 0;
    await expect(
      inferConversationDecision(
        input,
        provider,
        new AbortController().signal,
        transport(async () => {
          calls++;
          return new Response("server-only-secret private stack trace", {
            status: 500,
          });
        }),
      ),
    ).rejects.toThrow("provider rejected");
    expect(calls).toBe(1);
  });
  test("rejects malformed JSON, unsupported actions and incomplete responses", async () => {
    for (const result of [
      new Response("not-json"),
      response({ type: "propose_build", content: "Build", prompt: "Build" }),
      response({ type: "answer", content: "Unfinished" }, "length"),
    ])
      await expect(
        inferConversationDecision(
          input,
          provider,
          new AbortController().signal,
          transport(async () => result),
        ),
      ).rejects.toThrow();
  });
  test("bounds declared and streamed response sizes", async () => {
    for (const result of [
      new Response("small", { headers: { "content-length": "128001" } }),
      new Response(new Uint8Array(128001)),
    ])
      await expect(
        inferConversationDecision(
          input,
          provider,
          new AbortController().signal,
          transport(async () => result),
        ),
      ).rejects.toThrow("supported size");
  });
  test("abort cancels a stalled response body and releases its reader", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const result = inferConversationDecision(
      input,
      provider,
      controller.signal,
      transport(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    );
    await Bun.sleep(5);
    controller.abort();
    await expect(result).rejects.toThrow("stopped");
    expect(cancelled).toBe(true);
  });
  test("validates each mode after inference and starts no request for an already aborted turn", async () => {
    let calls = 0;
    const mock = transport(async () => {
      calls++;
      return response({ type: "answer", content: "Hello" });
    });
    expect(
      (
        await inferConversationDecision(
          { ...input, mode: "auto" },
          provider,
          new AbortController().signal,
          mock,
        )
      ).type,
    ).toBe("answer");
    await expect(
      inferConversationDecision(
        { ...input, mode: "build" },
        provider,
        new AbortController().signal,
        mock,
      ),
    ).rejects.toThrow("validated");
    const controller = new AbortController();
    controller.abort();
    await expect(
      inferConversationDecision(input, provider, controller.signal, mock),
    ).rejects.toThrow("stopped");
    expect(calls).toBe(2);
  });
});
