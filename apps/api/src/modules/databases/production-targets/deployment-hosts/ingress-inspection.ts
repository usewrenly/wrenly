/** Verify the public HTTP relay independently; generated applications never receive its network access. */
import { z } from "zod";
import {
  ProductionRuntimeIngressDiscovery,
  ProductionRuntimeApplicationReply,
} from "@wrenly/db/production-host-contract";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
import type { ProductionApplicationScope } from "./application-inspection";
const Strings = z.array(z.string());
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const ContainerId = z.string().regex(/^[a-f0-9]{64}$/);
const Image = z.object({
  Id: ImageId,
  Config: z.object({
    Env: Strings.nullable(),
    Entrypoint: Strings,
    Cmd: Strings.nullish(),
    Labels: z.record(z.string(), z.string()),
  }),
});
const Container = z.object({
  Id: ContainerId,
  Image: ImageId,
  Config: z.object({
    User: z.literal("1000:1000"),
    Env: Strings.nullable(),
    Entrypoint: Strings,
    Cmd: Strings.nullish(),
    Labels: z.record(z.string(), z.string()),
    OpenStdin: z.literal(false),
    Tty: z.literal(false),
  }),
  HostConfig: z.object({
    NetworkMode: z.string(),
    ReadonlyRootfs: z.literal(true),
    Privileged: z.literal(false),
    AutoRemove: z.literal(false),
    PidMode: z.literal(""),
    IpcMode: z.enum(["private", ""]),
    UTSMode: z.literal(""),
    CapDrop: Strings,
    CapAdd: Strings.nullish(),
    SecurityOpt: Strings,
    Memory: z.literal(134217728),
    NanoCpus: z.literal(1000000000),
    PidsLimit: z.literal(64),
    RestartPolicy: z.object({ Name: z.literal("no") }),
    Binds: Strings.nullish(),
    VolumesFrom: Strings.nullish(),
    ExtraHosts: Strings.nullish(),
    Devices: z.array(z.unknown()).nullish(),
    DeviceRequests: z.array(z.unknown()).nullish(),
    Tmpfs: z.record(z.string(), z.string()).nullish(),
  }),
  Mounts: z
    .array(
      z.object({
        Type: z.literal("volume"),
        Name: z.string(),
        Driver: z.literal("local"),
        Destination: z.literal("/run/wrenly-http"),
        RW: z.literal(false),
      }),
    )
    .length(1),
  NetworkSettings: z.object({
    Networks: z.record(
      z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
      z.object({ NetworkID: z.union([ContainerId, z.literal("")]) }),
    ),
  }),
  State: z.object({
    Running: z.boolean(),
    Paused: z.literal(false),
    Restarting: z.literal(false),
    Dead: z.literal(false),
  }),
});
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
/** Exact image and volume identity matter even when a provider reports the relay healthy. */
export function inspectProductionIngressContainer(
  raw: unknown,
  rawImage: unknown,
  scope: ProductionApplicationScope,
): {
  containerId: string;
  imageId: string;
  running: boolean;
  networkIds: string[];
} {
  try {
    z.object({
      deploymentId: z.uuid(),
      projectId: z.uuid(),
      resourceId: z.uuid(),
      containerId: ContainerId,
      imageId: ImageId,
    })
      .strict()
      .parse(scope);
    const container = Container.parse(raw),
      image = Image.parse(rawImage),
      host = container.HostConfig;
    const labels = {
      "io.wrenly.deployment-id": scope.deploymentId,
      "io.wrenly.project-id": scope.projectId,
      "io.wrenly.database-id": scope.resourceId,
      "io.wrenly.database-environment": "production",
      "io.wrenly.role": "production-ingress",
    };
    const networkIds = Object.entries(container.NetworkSettings.Networks).map(
      ([name, network]) => network.NetworkID || name,
    );
    if (
      container.Id !== scope.containerId ||
      container.Image !== scope.imageId ||
      image.Id !== scope.imageId ||
      image.Config.Labels["io.wrenly.runtime-role"] !== "deployment-ingress" ||
      image.Config.Labels["io.wrenly.runtime-version"] !== "1" ||
      Object.entries(labels).some(
        ([key, value]) => container.Config.Labels[key] !== value,
      ) ||
      !same(container.Config.Env, image.Config.Env) ||
      !same(container.Config.Entrypoint, [
        "bun",
        "--no-env-file",
        "/wrenly/ingress.js",
      ]) ||
      !same(container.Config.Entrypoint, image.Config.Entrypoint) ||
      !same(container.Config.Cmd ?? null, image.Config.Cmd ?? null) ||
      !same(
        host.CapDrop.map((value) => value.replace(/^CAP_/, "")),
        ["ALL"],
      ) ||
      (host.CapAdd?.length ?? 0) ||
      !same(host.SecurityOpt, ["no-new-privileges:true"]) ||
      (host.Binds?.length ?? 0) ||
      (host.VolumesFrom?.length ?? 0) ||
      (host.ExtraHosts?.length ?? 0) ||
      (host.Devices?.length ?? 0) ||
      (host.DeviceRequests?.length ?? 0) ||
      Object.keys(host.Tmpfs ?? {}).length ||
      ["host", "none", "default", "bridge"].includes(host.NetworkMode) ||
      host.NetworkMode.startsWith("container:") ||
      !networkIds.length ||
      networkIds.length > 4 ||
      new Set(networkIds).size !== networkIds.length ||
      container.Mounts[0]!.Name !==
        `wrenly-deployment-http-${scope.deploymentId}`
    )
      throw new Error("Ingress isolation changed.");
    return {
      containerId: container.Id,
      imageId: container.Image,
      running: container.State.Running,
      networkIds,
    };
  } catch {
    throw new Error(
      "Production ingress identity or isolation could not be verified.",
    );
  }
}
/** Read-only discovery never starts a relay or receives database credentials. */
export async function findRuntimeIngress(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof ProductionRuntimeApplicationReply>> {
  const input = ProductionRuntimeIngressDiscovery.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  const inspect = async (kind: string, id: string): Promise<unknown> =>
    z
      .array(z.unknown())
      .length(1)
      .parse(
        JSON.parse(await runRuntimeHostDocker([kind, "inspect", id], signal)),
      )[0];
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    const ids = (
      await runRuntimeHostDocker(
        [
          "container",
          "ls",
          "--all",
          "--no-trunc",
          ...Object.entries({
            "io.wrenly.deployment-id": input.deploymentId,
            "io.wrenly.project-id": input.projectId,
            "io.wrenly.database-id": input.resourceId,
            "io.wrenly.role": "production-ingress",
          }).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]),
          "--format",
          "{{.ID}}",
        ],
        signal,
      )
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    const [containerId] = z.array(ContainerId).length(1).parse(ids);
    const result = inspectProductionIngressContainer(
      await inspect("container", containerId!),
      await inspect("image", input.imageId),
      {
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        resourceId: input.resourceId,
        imageId: input.imageId,
        containerId: containerId!,
      },
    );
    for (const id of result.networkIds) {
      const network = z
        .object({
          Id: ContainerId,
          Name: z.string(),
          Driver: z.literal("bridge"),
          Scope: z.literal("local"),
          Ingress: z.literal(false),
        })
        .parse(await inspect("network", id));
      if (
        (network.Id !== id && network.Name !== id) ||
        network.Name === `wrenly-deployment-network-${input.deploymentId}`
      )
        throw new Error("Ingress network changed.");
    }
    const volume = z
      .object({
        Name: z.string(),
        Driver: z.literal("local"),
        Scope: z.literal("local"),
        Options: z.record(z.string(), z.string()).nullish(),
        Labels: z.record(z.string(), z.string()),
      })
      .parse(
        await inspect("volume", `wrenly-deployment-http-${input.deploymentId}`),
      );
    if (
      volume.Name !== `wrenly-deployment-http-${input.deploymentId}` ||
      Object.keys(volume.Options ?? {}).length ||
      Object.entries({
        "io.wrenly.deployment-id": input.deploymentId,
        "io.wrenly.project-id": input.projectId,
        "io.wrenly.database-id": input.resourceId,
        "io.wrenly.database-environment": "production",
        "io.wrenly.role": "production-http-volume",
      }).some(([key, value]) => volume.Labels[key] !== value)
    )
      throw new Error("Ingress volume changed.");
    lock.assertHeld();
    signal.throwIfAborted();
    return ProductionRuntimeApplicationReply.parse({
      version: 1,
      nonce: input.nonce,
      dockerId,
      containerId: result.containerId,
      imageId: result.imageId,
      running: result.running,
    });
  } catch {
    throw new Error(
      "Production HTTP relay could not be verified. No runtime was changed.",
    );
  } finally {
    await lock.release();
  }
}
