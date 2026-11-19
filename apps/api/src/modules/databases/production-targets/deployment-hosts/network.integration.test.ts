import { expect, test } from "bun:test";
import { inspectRuntimeHost } from "./helper";
import { executeRuntimeNetworkRequest } from "./network";
const native =
  process.env.WRENLY_TEST_RUNTIME_HOST_NETWORK === "true" ? test : test.skip;
native(
  "broker network creation binds exact daemon, deployment and resource",
  async () => {
    const deploymentId = crypto.randomUUID();
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      AbortSignal.timeout(10000),
    );
    const input = {
      version: 1 as const,
      action: "create-runtime-network" as const,
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
      const missing = await executeRuntimeNetworkRequest(
        { ...input, action: "inspect-runtime-network" },
        host.dockerId,
        signal,
      );
      expect(missing.network).toBeNull();
      await expect(
        executeRuntimeNetworkRequest(input, "foreign", signal),
      ).rejects.toThrow("identity changed");
      const created = await executeRuntimeNetworkRequest(
        input,
        host.dockerId,
        signal,
      );
      expect(created.network?.name).toBe(
        `wrenly-deployment-network-${deploymentId}`,
      );
      expect(created.network?.id).toMatch(/^[a-f0-9]{64}$/);
      await expect(
        executeRuntimeNetworkRequest(input, host.dockerId, signal),
      ).rejects.toThrow("could not be confirmed");
      expect(
        await executeRuntimeNetworkRequest(
          { ...input, action: "inspect-runtime-network" },
          host.dockerId,
          signal,
        ),
      ).toEqual(created);
      await expect(
        executeRuntimeNetworkRequest(
          {
            ...input,
            action: "inspect-runtime-network",
            resourceId: crypto.randomUUID(),
          },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow("could not be confirmed");
    } finally {
      const child = Bun.spawn(
        [
          "docker",
          "--host",
          "unix:///var/run/docker.sock",
          "network",
          "rm",
          `wrenly-deployment-network-${deploymentId}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      await child.exited;
    }
  },
  30000,
);
