import { expect, test } from "bun:test";
import { createInferenceFetch } from "../../src/network/transport";
test("inference transport rejects endpoint escapes and streaming requests before forwarding credentials", async () => {
  let lookups = 0;
  const fetcher = createInferenceFetch(
    { baseUrl: "https://provider.example/v1", kind: "cloud" },
    async () => {
      lookups++;
      return [{ address: "8.8.8.8", family: 4 }];
    },
  );
  await expect(
    fetcher("https://foreign.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }),
  ).rejects.toThrow("configured provider");
  await expect(
    fetcher("https://provider.example/v1/other", {
      method: "POST",
      body: "{}",
    }),
  ).rejects.toThrow("configured provider");
  expect(lookups).toBe(0);
  await expect(
    fetcher("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    }),
  ).rejects.toThrow("Streaming inference");
  expect(lookups).toBe(1);
});

test("inference deadline interrupts a stalled DNS wait before credentials can be sent", async () => {
  const never = new Promise<Array<{ address: string; family: number }>>(
    () => {},
  );
  const fetcher = createInferenceFetch(
    { baseUrl: "https://provider.example/v1", kind: "cloud", timeoutMs: 20 },
    () => never,
  );
  await expect(
    fetcher("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: "{}",
    }),
  ).rejects.toThrow("deadline");
}, 1000);
