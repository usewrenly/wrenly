/** Read-only proof for an uncertain broker start; never sends another credential or starts a stopped process. */
import { z } from "zod";
import {
  ProductionRuntimeBrokerInspection,
  ProductionRuntimeBrokerInspectionReply,
} from "@wrenly/db/production-host-contract";
import { productionSocketHostMapping } from "@wrenly/sandbox/production-database-socket-policy";
import { assertProductionBrokerMemoryMounts } from "./broker-policy";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
const Strings = z.array(z.string());
const Inspect = z.object({
  Id: z.string(),
  Name: z.string(),
  Image: z.string(),
  Config: z.object({
    User: z.literal("1000:1000"),
    Env: Strings.nullable(),
    Entrypoint: Strings,
    Labels: z.record(z.string(), z.string()),
    OpenStdin: z.literal(true),
    Tty: z.literal(false),
  }),
  HostConfig: z.object({
    NetworkMode: z.string(),
    Tmpfs: z.record(z.string(), z.string()),
    Sysctls: z.object({ "net.ipv4.ip_forward": z.literal("0") }).strict(),
    AutoRemove: z.literal(false),
    ReadonlyRootfs: z.literal(true),
    Privileged: z.literal(false),
    PidMode: z.literal(""),
    IpcMode: z.enum(["private", ""]),
    UTSMode: z.literal(""),
    CapDrop: Strings,
    CapAdd: Strings.nullish(),
    SecurityOpt: Strings,
    Memory: z.literal(67108864),
    NanoCpus: z.literal(250000000),
    PidsLimit: z.literal(32),
    RestartPolicy: z.object({ Name: z.literal("no") }),
    LogConfig: z.object({ Type: z.literal("none") }),
    ExtraHosts: Strings,
    Devices: z.array(z.unknown()).nullish(),
    DeviceRequests: z.array(z.unknown()).nullish(),
    Binds: Strings.nullish(),
  }),
  Mounts: z
    .array(
      z.object({
        Type: z.literal("volume"),
        Name: z.string(),
        Destination: z.literal("/run/wrenly-database"),
        RW: z.literal(true),
        Driver: z.literal("local"),
      }),
    )
    .length(1),
  State: z.object({
    Running: z.boolean(),
    Paused: z.literal(false),
    Restarting: z.literal(false),
    Dead: z.literal(false),
    Health: z.object({ Status: z.string() }).optional(),
  }),
});
/** The saved container ID is mandatory: a same-name container is never silently adopted. */
export async function inspectRuntimeDatabaseBroker(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof ProductionRuntimeBrokerInspectionReply>> {
  const input = ProductionRuntimeBrokerInspection.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    const info = Inspect.parse(
      z
        .array(z.unknown())
        .length(1)
        .parse(
          JSON.parse(
            await runRuntimeHostDocker(
              ["container", "inspect", input.containerId],
              signal,
            ),
          ),
        )[0],
    );
    const image = z
      .object({
        Id: z.string(),
        Config: z.object({
          Env: Strings.nullable().optional(),
          Entrypoint: Strings,
        }),
      })
      .parse(
        z
          .array(z.unknown())
          .length(1)
          .parse(
            JSON.parse(
              await runRuntimeHostDocker(
                ["image", "inspect", input.imageId],
                signal,
              ),
            ),
          )[0],
      );
    const labels = {
      "io.wrenly.deployment-id": input.deploymentId,
      "io.wrenly.project-id": input.projectId,
      "io.wrenly.database-id": input.resourceId,
      "io.wrenly.database-environment": "production",
      "io.wrenly.role": "production-database-broker",
    };
    const volumeName = `wrenly-deployment-db-${input.deploymentId}`,
      host = info.HostConfig;
    assertProductionBrokerMemoryMounts(host.Tmpfs);
    if (
      info.Id !== input.containerId ||
      info.Name !== `/wrenly-deployment-broker-${input.deploymentId}` ||
      info.Image !== input.imageId ||
      image.Id !== input.imageId ||
      Object.entries(labels).some(
        ([key, value]) => info.Config.Labels[key] !== value,
      ) ||
      JSON.stringify(info.Config.Env) !== JSON.stringify(image.Config.Env) ||
      JSON.stringify(info.Config.Entrypoint) !==
        JSON.stringify(["bun", "--no-env-file", "/wrenly/entrypoint.ts"]) ||
      JSON.stringify(info.Config.Entrypoint) !==
        JSON.stringify(image.Config.Entrypoint) ||
      host.NetworkMode !== input.networkId ||
      JSON.stringify(
        host.CapDrop.map((value) => value.replace(/^CAP_/, "")),
      ) !== JSON.stringify(["ALL"]) ||
      (host.CapAdd?.length ?? 0) ||
      JSON.stringify(host.SecurityOpt) !==
        JSON.stringify(["no-new-privileges:true"]) ||
      JSON.stringify(host.ExtraHosts) !==
        JSON.stringify([productionSocketHostMapping(input.upstream)]) ||
      (host.Devices?.length ?? 0) ||
      (host.DeviceRequests?.length ?? 0) ||
      (host.Binds?.length ?? 0) ||
      info.Mounts[0]!.Name !== volumeName
    )
      throw new Error("Broker isolation changed.");
    const volume = z
      .array(
        z.object({
          Name: z.string(),
          Driver: z.literal("local"),
          Scope: z.literal("local"),
          Labels: z.record(z.string(), z.string()),
          Options: z.record(z.string(), z.string()).nullish(),
        }),
      )
      .length(1)
      .parse(
        JSON.parse(
          await runRuntimeHostDocker(["volume", "inspect", volumeName], signal),
        ),
      )[0]!;
    const network = z
      .array(
        z.object({
          Id: z.string(),
          Name: z.string(),
          Driver: z.literal("bridge"),
          Scope: z.literal("local"),
          Internal: z.literal(false),
          EnableIPv6: z.literal(false),
          Attachable: z.literal(false),
          Ingress: z.literal(false),
          Labels: z.record(z.string(), z.string()),
          Options: z.record(z.string(), z.string()),
          Containers: z.record(z.string(), z.unknown()).nullish(),
        }),
      )
      .length(1)
      .parse(
        JSON.parse(
          await runRuntimeHostDocker(
            ["network", "inspect", input.networkId],
            signal,
          ),
        ),
      )[0]!;
    const { "io.wrenly.role": _role, ...resourceLabels } = labels;
    void _role;
    if (
      volume.Name !== volumeName ||
      Object.keys(volume.Options ?? {}).length ||
      Object.entries({
        ...resourceLabels,
        "io.wrenly.role": "production-database-volume",
      }).some(([key, value]) => volume.Labels[key] !== value) ||
      network.Id !== input.networkId ||
      network.Name !== `wrenly-deployment-network-${input.deploymentId}` ||
      Object.keys(network.Options).length ||
      Object.entries({
        ...resourceLabels,
        "io.wrenly.role": "production-database-network",
      }).some(([key, value]) => network.Labels[key] !== value) ||
      Object.keys(network.Containers ?? {}).some(
        (id) => id !== input.containerId,
      ) ||
      (info.State.Running &&
        !Object.hasOwn(network.Containers ?? {}, input.containerId))
    )
      throw new Error("Broker attached resources changed.");
    lock.assertHeld();
    signal.throwIfAborted();
    return ProductionRuntimeBrokerInspectionReply.parse({
      version: 1,
      nonce: input.nonce,
      dockerId,
      containerId: info.Id,
      imageId: info.Image,
      networkId: input.networkId,
      volumeName,
      running: info.State.Running,
      socketReady:
        info.State.Running && info.State.Health?.Status === "healthy",
    });
  } catch {
    throw new Error(
      "Production runtime broker inspection could not be verified. No credentials were resent.",
    );
  } finally {
    await lock.release();
  }
}
