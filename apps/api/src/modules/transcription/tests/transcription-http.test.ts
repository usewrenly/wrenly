import { expect, test } from "bun:test";
import { DICTATION_LIMITS, encodeDictationWav } from "@wrenly/audio";
import {
  createTranscriptionHttpHandlers,
  type TranscriptionHttpDependencies,
} from "../transcription-http";
function fixture() {
  let calls = 0;
  const dependencies: TranscriptionHttpDependencies = {
    webUrl: "http://localhost:3000",
    userId: async () => "owner",
    adapter: {
      available: () => true,
      transcribe: async () => {
        calls++;
        return "Make the title larger.";
      },
    },
  };
  return { dependencies, calls: () => calls };
}
function request(
  body: Uint8Array = encodeDictationWav(new Float32Array(1600).fill(0.1)),
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request("http://localhost:3002/api/transcription", {
    method: "POST",
    body: new Uint8Array(body),
    signal,
    headers: {
      origin: "http://localhost:3000",
      "idempotency-key": crypto.randomUUID(),
      ...headers,
    },
  });
}
test("dictation checks origin, account and availability before invoking transcription", async () => {
  const state = fixture(),
    handlers = createTranscriptionHttpHandlers(state.dependencies);
  expect(
    (
      await handlers.transcribe(
        request(undefined, { origin: "https://elsewhere.example" }),
      )
    ).status,
  ).toBe(403);
  state.dependencies.userId = async () => null;
  expect((await handlers.transcribe(request())).status).toBe(401);
  expect(
    (await handlers.capability(new Request("http://localhost/"))).status,
  ).toBe(401);
  state.dependencies.userId = async () => "owner";
  state.dependencies.adapter.available = () => false;
  expect((await handlers.transcribe(request())).status).toBe(503);
  expect(state.calls()).toBe(0);
});
test("only canonical audio reaches the adapter and transcript responses are never cacheable", async () => {
  const state = fixture(),
    handlers = createTranscriptionHttpHandlers(state.dependencies);
  expect(
    (
      await handlers.transcribe(
        request(new TextEncoder().encode("arbitrary codec")),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await handlers.transcribe(
        request(undefined, {
          "content-length": String(DICTATION_LIMITS.maximumUploadBytes + 1),
        }),
      )
    ).status,
  ).toBe(413);
  expect(
    (
      await handlers.transcribe(
        request(undefined, { "idempotency-key": "not-a-uuid" }),
      )
    ).status,
  ).toBe(400);
  expect(state.calls()).toBe(0);
  const response = await handlers.transcribe(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ text: "Make the title larger." });
  expect(response.headers.get("cache-control")).toBe("no-store");
});
test("actual streamed size is bounded even when no content length is provided", async () => {
  const state = fixture();
  expect(
    (
      await createTranscriptionHttpHandlers(state.dependencies).transcribe(
        request(new Uint8Array(DICTATION_LIMITS.maximumUploadBytes + 1)),
      )
    ).status,
  ).toBe(413);
  expect(state.calls()).toBe(0);
});
test("busy requests cannot release another recording's execution slot", async () => {
  const state = fixture();
  let finish: ((text: string) => void) | undefined;
  let entered = false;
  state.dependencies.adapter.transcribe = async () => {
    entered = true;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  };
  const handlers = createTranscriptionHttpHandlers(state.dependencies);
  const first = handlers.transcribe(request());
  while (!entered) await Bun.sleep(1);
  expect((await handlers.transcribe(request())).status).toBe(429);
  expect((await handlers.transcribe(request())).status).toBe(429);
  finish!("The first transcript");
  expect((await first).status).toBe(200);
  state.dependencies.adapter.transcribe = async () => "The next transcript";
  expect((await handlers.transcribe(request())).status).toBe(200);
});
test("revoked access discards a finished transcript and invalid output is not returned", async () => {
  const state = fixture();
  let checks = 0;
  state.dependencies.userId = async () => (++checks === 1 ? "owner" : null);
  const handlers = createTranscriptionHttpHandlers(state.dependencies);
  expect((await handlers.transcribe(request())).status).toBe(401);
  state.dependencies.userId = async () => "owner";
  for (const value of ["", "bad\u0000", "x".repeat(9000)]) {
    state.dependencies.adapter.transcribe = async () => value;
    expect((await handlers.transcribe(request())).status).toBe(400);
  }
});
test("cancelled input never starts inference and failures do not expose raw diagnostics", async () => {
  const state = fixture(),
    handlers = createTranscriptionHttpHandlers(state.dependencies);
  const controller = new AbortController();
  controller.abort();
  expect(
    (await handlers.transcribe(request(undefined, {}, controller.signal)))
      .status,
  ).toBe(400);
  expect(state.calls()).toBe(0);
  state.dependencies.adapter.transcribe = async () => {
    throw Error("private diagnostic /host/path token");
  };
  const response = await handlers.transcribe(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private diagnostic");
});
test("client abort does not free capacity before the adapter confirms cleanup", async () => {
  const state = fixture();
  let entered = false;
  let cleanup: (() => void) | undefined;
  state.dependencies.adapter.transcribe = async () => {
    entered = true;
    await new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    return "Late result";
  };
  const handlers = createTranscriptionHttpHandlers(state.dependencies);
  const controller = new AbortController();
  const first = handlers.transcribe(request(undefined, {}, controller.signal));
  while (!entered) await Bun.sleep(1);
  controller.abort();
  expect((await handlers.transcribe(request())).status).toBe(429);
  cleanup!();
  expect((await first).status).toBe(400);
});

test("silent recordings never invoke the native model", async () => {
  const state = fixture();
  const handlers = createTranscriptionHttpHandlers(state.dependencies);
  expect(
    (
      await handlers.transcribe(
        request(encodeDictationWav(new Float32Array(1600))),
      )
    ).status,
  ).toBe(400);
  expect(state.calls()).toBe(0);
});

test("native deadline returns a safe retryable timeout and releases capacity", async () => {
  const state = fixture();
  state.dependencies.adapter.transcribe = async () => {
    throw new DOMException("private native diagnostics", "TimeoutError");
  };
  const handlers = createTranscriptionHttpHandlers(state.dependencies);
  const response = await handlers.transcribe(request());
  expect(response.status).toBe(504);
  expect(await response.text()).not.toContain("private native diagnostics");
  state.dependencies.adapter.transcribe = async () => "Try again.";
  expect((await handlers.transcribe(request())).status).toBe(200);
});
