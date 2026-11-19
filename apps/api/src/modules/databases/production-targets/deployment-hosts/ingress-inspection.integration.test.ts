/** Stopped disposable relays prove the isolation checks without opening host ports or contacting an app/database. */
import { expect, test } from "bun:test";
import {
  findRuntimeIngress,
  inspectProductionIngressContainer,
} from "./ingress-inspection";
import { inspectRuntimeHost } from "./helper";
import { executeRuntimeVolumeRequest } from "./volumes";
import { runRuntimeHostDocker } from "./docker-command";
const native =
  process.env.WRENLY_TEST_RUNTIME_INGRESS_INSPECTION === "true"
    ? test
    : test.skip;
native(
  "Production relay discovery rejects credential access and foreign ownership",
  async () => {
    const signal = AbortSignal.timeout(20000),
      deploymentId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      resourceId = crypto.randomUUID();
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      signal,
    );
    const base = {
      version: 1 as const,
      nonce: crypto.randomUUID(),
      expectedDockerId: host.dockerId,
      deploymentId,
      projectId,
      resourceId,
      claimToken: crypto.randomUUID(),
      confirmDurableIntent: true as const,
    };
    const volume = `wrenly-deployment-http-${deploymentId}`,
      network = `wrenly-ingress-fixture-${deploymentId}`;
    let containerId: string | undefined;
    try {
      const image = JSON.parse(
        await runRuntimeHostDocker(
          ["image", "inspect", "wrenly/deployment-ingress:1"],
          signal,
        ),
      )[0] as { Id: string };
      await executeRuntimeVolumeRequest(
        { ...base, action: "create-http-volume" },
        host.dockerId,
        signal,
      );
      await runRuntimeHostDocker(["network", "create", network], signal);
      containerId = await runRuntimeHostDocker(
        [
          "create",
          "--network",
          network,
          "--user",
          "1000:1000",
          "--read-only",
          "--memory",
          "128m",
          "--cpus",
          "1",
          "--pids-limit",
          "64",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges:true",
          "--restart",
          "no",
          ...Object.entries({
            "io.wrenly.deployment-id": deploymentId,
            "io.wrenly.project-id": projectId,
            "io.wrenly.database-id": resourceId,
            "io.wrenly.database-environment": "production",
            "io.wrenly.role": "production-ingress",
          }).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          "--mount",
          `type=volume,src=${volume},dst=/run/wrenly-http,readonly`,
          image.Id,
        ],
        signal,
      );
      const request = {
        ...base,
        action: "find-runtime-ingress",
        imageId: image.Id,
      };
      const checked = await findRuntimeIngress(request, host.dockerId, signal);
      expect(checked.containerId).toBe(containerId);
      expect(checked.running).toBe(false);
      await expect(
        findRuntimeIngress(
          { ...request, projectId: crypto.randomUUID() },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow("could not be verified");
      const info = JSON.parse(
        await runRuntimeHostDocker(
          ["container", "inspect", containerId],
          signal,
        ),
      )[0] as Record<string, unknown>;
      const scope = {
        deploymentId,
        projectId,
        resourceId,
        containerId,
        imageId: image.Id,
      };
      expect(
        inspectProductionIngressContainer(info, image, scope).containerId,
      ).toBe(containerId);
      for (const change of [
        { ...info, Config: { ...(info.Config as object), User: "0:0" } },
        {
          ...info,
          Config: {
            ...(info.Config as object),
            Env: ["PGPASSWORD=fixture-only"],
          },
        },
        {
          ...info,
          HostConfig: { ...(info.HostConfig as object), NetworkMode: "host" },
        },
        {
          ...info,
          HostConfig: { ...(info.HostConfig as object), Privileged: true },
        },
        {
          ...info,
          Mounts: [
            {
              Type: "volume",
              Name: volume,
              Driver: "local",
              Destination: "/run/wrenly-database",
              RW: false,
            },
          ],
        },
        {
          ...info,
          Mounts: [
            {
              Type: "volume",
              Name: volume,
              Driver: "local",
              Destination: "/run/wrenly-http",
              RW: true,
            },
          ],
        },
      ])
        expect(() =>
          inspectProductionIngressContainer(change, image, scope),
        ).toThrow("isolation");
    } finally {
      const cleanup = AbortSignal.timeout(10000);
      if (containerId)
        await runRuntimeHostDocker(
          ["container", "rm", "--force", containerId],
          cleanup,
        );
      await runRuntimeHostDocker(["network", "rm", network], cleanup).catch(
        () => undefined,
      );
      await runRuntimeHostDocker(["volume", "rm", volume], cleanup).catch(
        () => undefined,
      );
    }
  },
  20000,
);
