import { expect, test } from "bun:test";
import { inspectRuntimeHost } from "./helper";
import { executeRuntimeVolumeRequest } from "./volumes";
import { acquireRuntimeHostLock } from "./host-lock";
const native =
  process.env.WRENLY_TEST_RUNTIME_HOST_VOLUMES === "true" ? test : test.skip;
native(
  "deployment socket volumes require ownership and explicit inspection",
  async () => {
    const deploymentId = crypto.randomUUID();
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      AbortSignal.timeout(10000),
    );
    const request = {
      version: 1 as const,
      action: "create-http-volume" as const,
      nonce: crypto.randomUUID(),
      expectedDockerId: host.dockerId,
      deploymentId,
      projectId: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
      claimToken: crypto.randomUUID(),
      confirmDurableIntent: true as const,
    };
    const signal = AbortSignal.timeout(30000);
    try {
      const first = await executeRuntimeVolumeRequest(
        request,
        host.dockerId,
        signal,
      );
      expect(first.http?.name).toBe(`wrenly-deployment-http-${deploymentId}`);
      expect(first.database).toBeNull();
      await expect(
        executeRuntimeVolumeRequest(request, host.dockerId, signal),
      ).rejects.toThrow("could not be confirmed");
      const both = await executeRuntimeVolumeRequest(
        { ...request, action: "create-database-volume" },
        host.dockerId,
        signal,
      );
      expect(both.database?.name).toBe(`wrenly-deployment-db-${deploymentId}`);
      const checked = await executeRuntimeVolumeRequest(
        { ...request, action: "inspect-runtime-volumes" },
        host.dockerId,
        signal,
      );
      expect(checked).toEqual(both);
      await expect(
        executeRuntimeVolumeRequest(
          {
            ...request,
            projectId: crypto.randomUUID(),
            action: "inspect-runtime-volumes",
          },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow("could not be confirmed");
    } finally {
      for (const name of [
        `wrenly-deployment-http-${deploymentId}`,
        `wrenly-deployment-db-${deploymentId}`,
      ]) {
        const child = Bun.spawn(
          [
            "docker",
            "--host",
            "unix:///var/run/docker.sock",
            "volume",
            "rm",
            name,
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        await child.exited;
      }
    }
  },
  30000,
);
native("host lock excludes concurrent work and releases on close", async () => {
  const id = crypto.randomUUID();
  const first = await acquireRuntimeHostLock(id);
  try {
    await expect(acquireRuntimeHostLock(id)).rejects.toThrow("active");
    first.assertHeld();
  } finally {
    await first.release();
  }
  expect(() => first.assertHeld()).toThrow("no longer held");
  const second = await acquireRuntimeHostLock(id);
  second.assertHeld();
  await second.release();
});
