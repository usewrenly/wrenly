import { expect, test } from "bun:test";
import { resolveRuntimeHostAddresses } from "./transport";
const signal = (): AbortSignal => AbortSignal.timeout(1000);
test("host resolution pins the complete private IPv4 set and rejects mixed or invalid answers", async () => {
  expect(
    await resolveRuntimeHostAddresses(
      "deploy.internal.test",
      signal(),
      async () => [
        { address: "10.2.3.4", family: 4 },
        { address: "10.2.3.5", family: 4 },
        { address: "10.2.3.4", family: 4 },
      ],
    ),
  ).toEqual(["10.2.3.4", "10.2.3.5"]);
  for (const rows of [
    [],
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "8.8.8.8", family: 4 }],
    [{ address: "10.2.3.4", family: 6 }],
    [
      { address: "10.2.3.4", family: 4 },
      { address: "8.8.8.8", family: 4 },
    ],
  ]) {
    await expect(
      resolveRuntimeHostAddresses(
        "deploy.internal.test",
        signal(),
        async () => rows,
      ),
    ).rejects.toThrow();
  }
});
test("host resolution cancellation and invalid hostnames stop before an authentication attempt", async () => {
  const cancelled = AbortSignal.abort();
  await expect(
    resolveRuntimeHostAddresses(
      "deploy.internal.test",
      cancelled,
      async () => new Promise(() => {}),
    ),
  ).rejects.toThrow();
  let lookups = 0;
  await expect(
    resolveRuntimeHostAddresses("-oProxyCommand=unsafe", signal(), async () => {
      lookups++;
      return [{ address: "10.2.3.4", family: 4 }];
    }),
  ).rejects.toThrow();
  expect(lookups).toBe(0);
});
