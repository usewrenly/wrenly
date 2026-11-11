/** Broker readiness is socket readiness only; upstream TLS/CRUD acceptance is a separate gate. */
import { expect, test } from "bun:test";
import { inspectRuntimeHost } from "./helper";
import { executeRuntimeVolumeRequest } from "./volumes";
import { executeRuntimeNetworkRequest } from "./network";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
import { createRuntimeDatabaseBroker } from "./broker";
import { runRuntimeHostDocker } from "./docker-command";
const native =
  process.env.WRENLY_TEST_RUNTIME_HOST_BROKER === "true" ? test : test.skip;
native(
  "runtime-only broker starts with credentials absent from Docker configuration",
  async () => {
    const signal = AbortSignal.timeout(30000);
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      signal,
    );
    const deploymentId = crypto.randomUUID(),
      resourceId = crypto.randomUUID();
    const base = {
      version: 1 as const,
      nonce: crypto.randomUUID(),
      expectedDockerId: host.dockerId,
      deploymentId,
      resourceId,
      projectId: crypto.randomUUID(),
      claimToken: crypto.randomUUID(),
      confirmDurableIntent: true as const,
    };
    const image = JSON.parse(
      await runRuntimeHostDocker(
        ["image", "inspect", "wrenly/database-socket:2"],
        signal,
      ),
    )[0] as { Id: string };
    const name = `wrenly-deployment-broker-${deploymentId}`,
      volumeName = `wrenly-deployment-db-${deploymentId}`,
      networkName = `wrenly-deployment-network-${deploymentId}`;
    try {
      await executeRuntimeVolumeRequest(
        { ...base, action: "create-database-volume" },
        host.dockerId,
        signal,
      );
      const network = await executeRuntimeNetworkRequest(
        { ...base, action: "create-runtime-network" },
        host.dockerId,
        signal,
      );
      const request = {
        ...base,
        action: "create-runtime-broker",
        imageId: image.Id,
        networkId: network.network!.id,
        upstream: {
          hostname: "fixture.internal.test",
          address: "10.0.0.1",
          port: 9,
        },
        addresses: ["10.0.0.1"],
        runtimeRole: {
          user: `wrenly_${resourceId.replaceAll("-", "")}_runtime`,
          password: "c".repeat(64),
        },
      };
      const resolver = async () => [{ address: "10.0.0.1", family: 4 }];
      await expect(
        createRuntimeDatabaseBroker(
          {
            ...request,
            runtimeRole: {
              ...request.runtimeRole,
              user: request.runtimeRole.user.replace("runtime", "migrate"),
            },
          },
          host.dockerId,
          signal,
          resolver,
        ),
      ).rejects.toThrow("matching runtime role");
      const reply = await createRuntimeDatabaseBroker(
        request,
        host.dockerId,
        signal,
        resolver,
      );
      expect(reply.volumeName).toBe(volumeName);
      const inspectionRequest = {
        ...base,
        action: "inspect-runtime-broker",
        containerId: reply.containerId,
        imageId: image.Id,
        networkId: network.network!.id,
        upstream: request.upstream,
      };
      const checked = await inspectRuntimeDatabaseBroker(
        inspectionRequest,
        host.dockerId,
        signal,
      );
      expect(checked.socketReady).toBe(true);
      await expect(
        inspectRuntimeDatabaseBroker(
          { ...inspectionRequest, projectId: crypto.randomUUID() },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow("No credentials were resent");

      const inspection = await runRuntimeHostDocker(
        ["container", "inspect", reply.containerId],
        signal,
      );
      expect(inspection).not.toContain(request.runtimeRole.password);
      const info = JSON.parse(inspection)[0] as {
        State: { Health: { Status: string } };
        HostConfig: { LogConfig: { Type: string }; NetworkMode: string };
      };
      expect(info.State.Health.Status).toBe("healthy");
      expect(info.HostConfig.LogConfig.Type).toBe("none");
      expect(info.HostConfig.NetworkMode).toBe(network.network!.id);
      await expect(
        createRuntimeDatabaseBroker(request, host.dockerId, signal, resolver),
      ).rejects.toThrow("could not be confirmed");
      await runRuntimeHostDocker(
        ["container", "stop", "--time", "1", reply.containerId],
        signal,
      );
      const stopped = await inspectRuntimeDatabaseBroker(
        inspectionRequest,
        host.dockerId,
        signal,
      );
      expect(stopped.running).toBe(false);
      expect(stopped.socketReady).toBe(false);
    } finally {
      const cleanup = AbortSignal.timeout(10000);
      await runRuntimeHostDocker(
        ["container", "rm", "--force", name],
        cleanup,
      ).catch(() => undefined);
      await runRuntimeHostDocker(["volume", "rm", volumeName], cleanup).catch(
        () => undefined,
      );
      await runRuntimeHostDocker(["network", "rm", networkName], cleanup).catch(
        () => undefined,
      );
    }
  },
  30000,
);
