import { expect, test } from "bun:test";
import { readRuntimeHostRequest, inspectRuntimeHost } from "./helper";
function input(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}
test("host helper accepts only bounded exact inspection requests", async () => {
  const request = { version: 1, action: "inspect", nonce: crypto.randomUUID() };
  expect(await readRuntimeHostRequest(input(JSON.stringify(request)))).toEqual(
    request,
  );
  for (const invalid of [
    "{",
    JSON.stringify({ ...request, command: "anything" }),
    JSON.stringify({ ...request, action: "exec" }),
    "x".repeat(128 * 1024 + 1),
  ])
    await expect(readRuntimeHostRequest(input(invalid))).rejects.toThrow();
});
test("invalid helper actions and cancellation never start inspection", async () => {
  await expect(
    inspectRuntimeHost({ action: "exec" }, new AbortController().signal),
  ).rejects.toThrow();
  await expect(
    inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow("could not be verified");
});

const native =
  process.env.WRENLY_TEST_RUNTIME_HOST_HELPER === "true" ? test : test.skip;
native(
  "fixed helper reads a real local daemon without changing Docker resources",
  async () => {
    const nonce = crypto.randomUUID();
    const result = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce },
      AbortSignal.timeout(10_000),
    );
    expect(result.nonce).toBe(nonce);
    expect(result.operatingSystem).toBe("linux");
    expect(result.dockerId.length).toBeGreaterThan(0);
  },
);

import { executeRuntimeVolumeRequest } from "./volumes";
test("volume requests require exact daemon identity before Docker access", async () => {
  const request = {
    version: 1,
    action: "create-http-volume",
    nonce: crypto.randomUUID(),
    expectedDockerId: "fixture-daemon",
    deploymentId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    claimToken: crypto.randomUUID(),
    confirmDurableIntent: true,
  };
  expect(await readRuntimeHostRequest(input(JSON.stringify(request)))).toEqual(
    request,
  );
  await expect(
    executeRuntimeVolumeRequest(
      request,
      "foreign-daemon",
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow("identity changed");
  for (const invalid of [
    { ...request, confirmDurableIntent: false },
    { ...request, path: "/anything" },
    { ...request, deploymentId: "../escape" },
  ]) {
    await expect(
      readRuntimeHostRequest(input(JSON.stringify(invalid))),
    ).rejects.toThrow();
  }
});
