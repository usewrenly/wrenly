/** Inspect the created application before delivering a runtime password to its trusted guardian. */
import { z } from "zod";
import {
  ProductionRuntimeApplicationInspection,
  ProductionRuntimeApplicationReply,
} from "@wrenly/db/production-host-contract";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
const Id = z.string().regex(/^[a-f0-9]{64}$/);
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Strings = z.array(z.string());
const Image = z.object({
  Id: ImageId,
  Config: z.object({
    Labels: z.record(z.string(), z.string()),
    Env: Strings.nullable(),
    Entrypoint: Strings.nullable(),
    Cmd: Strings.nullish().transform((value) => value ?? null),
  }),
});
const Container = z.object({
  Id,
  Image: ImageId,
  Config: z.object({
    User: z.string(),
    Env: Strings.nullable(),
    Entrypoint: Strings.nullable(),
    Cmd: Strings.nullable(),
    OpenStdin: z.boolean(),
    Tty: z.boolean(),
    Labels: z.record(z.string(), z.string()),
  }),
  HostConfig: z.object({
    NetworkMode: z.literal("none"),
    ReadonlyRootfs: z.literal(true),
    Privileged: z.literal(false),
    AutoRemove: z.literal(false),
    PidMode: z.literal(""),
    IpcMode: z.enum(["private", ""]),
    UTSMode: z.literal(""),
    CapDrop: Strings,
    CapAdd: Strings,
    SecurityOpt: Strings,
    Memory: z.literal(2147483648),
    NanoCpus: z.literal(2000000000),
    PidsLimit: z.literal(256),
    RestartPolicy: z.object({ Name: z.literal("no") }),
    Tmpfs: z.record(z.string(), z.string()),
    Binds: Strings.nullable().optional(),
    Devices: z.array(z.unknown()).nullable().optional(),
    DeviceRequests: z.array(z.unknown()).nullable().optional(),
  }),
  Mounts: z.array(
    z.object({
      Type: z.literal("volume"),
      Name: z.string(),
      Destination: z.string(),
      RW: z.boolean(),
      Driver: z.literal("local"),
    }),
  ),
  State: z.object({
    Running: z.boolean(),
    Paused: z.literal(false),
    Restarting: z.literal(false),
    Dead: z.literal(false),
  }),
});
export interface ProductionApplicationScope {
  deploymentId: string;
  projectId: string;
  resourceId: string;
  containerId: string;
  imageId: string;
}
function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function capabilities(values: string[]): string[] {
  return values.map((value) => value.replace(/^CAP_/, "")).sort();
}
/** A running container is not trusted merely because Coolify reports success; verify image, isolation and both socket mounts first. */
export function inspectProductionApplicationContainer(
  raw: unknown,
  rawImage: unknown,
  scope: ProductionApplicationScope,
): { containerId: string; imageId: string; running: boolean } {
  try {
    z.object({
      deploymentId: z.uuid(),
      projectId: z.uuid(),
      resourceId: z.uuid(),
      containerId: Id,
      imageId: ImageId,
    })
      .strict()
      .parse(scope);
    const image = Image.parse(rawImage),
      container = Container.parse(raw);
    const labels = {
      "io.wrenly.deployment-id": scope.deploymentId,
      "io.wrenly.project-id": scope.projectId,
      "io.wrenly.database-id": scope.resourceId,
      "io.wrenly.database-environment": "production",
      "io.wrenly.role": "production-application",
    };
    if (
      container.Id !== scope.containerId ||
      container.Image !== scope.imageId ||
      image.Id !== scope.imageId ||
      image.Config.Labels["io.wrenly.database-runtime-version"] !== "1" ||
      Object.entries(labels).some(
        ([key, value]) => container.Config.Labels[key] !== value,
      ) ||
      !["0", "0:0"].includes(container.Config.User) ||
      !container.Config.OpenStdin ||
      container.Config.Tty
    )
      throw new Error("Application identity changed.");
    if (
      !equal(container.Config.Entrypoint, [
        "bun",
        "--no-env-file",
        "/wrenly/production-application.js",
      ]) ||
      !equal(container.Config.Entrypoint, image.Config.Entrypoint) ||
      !equal(container.Config.Cmd, image.Config.Cmd) ||
      !equal(container.Config.Env, image.Config.Env)
    )
      throw new Error("Application startup changed.");
    const host = container.HostConfig;
    const bootstrapOptions = new Set(
      (host.Tmpfs["/run/wrenly-bootstrap"] ?? "").split(","),
    );
    if (
      ![
        "rw",
        "noexec",
        "nosuid",
        "nodev",
        "size=1m",
        "uid=0",
        "gid=0",
        "mode=0700",
      ].every((option) => bootstrapOptions.has(option)) ||
      bootstrapOptions.size !== 8
    )
      throw new Error("Guardian state storage changed.");
    if (
      !equal(capabilities(host.CapDrop), ["ALL"]) ||
      !equal(capabilities(host.CapAdd), ["CHOWN", "SETGID", "SETUID"]) ||
      !equal(host.SecurityOpt, ["no-new-privileges:true"]) ||
      (host.Binds?.length ?? 0) ||
      (host.Devices?.length ?? 0) ||
      (host.DeviceRequests?.length ?? 0)
    )
      throw new Error("Application privilege changed.");
    const mounts = [...container.Mounts].sort((a, b) =>
      a.Destination.localeCompare(b.Destination),
    );
    const expected = [
      {
        Type: "volume",
        Name: `wrenly-deployment-db-${scope.deploymentId}`,
        Destination: "/run/wrenly-database",
        RW: false,
        Driver: "local",
      },
      {
        Type: "volume",
        Name: `wrenly-deployment-http-${scope.deploymentId}`,
        Destination: "/run/wrenly-http",
        RW: true,
        Driver: "local",
      },
    ];
    if (!equal(mounts, expected))
      throw new Error("Application storage changed.");
    return {
      containerId: container.Id,
      imageId: container.Image,
      running: container.State.Running,
    };
  } catch {
    throw new Error(
      "Production application isolation could not be verified. Runtime credentials were not approved for delivery.",
    );
  }
}

/** Read-only host check. The caller still needs a current publishing claim before credential delivery. */
export async function executeRuntimeApplicationInspection(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof ProductionRuntimeApplicationReply>> {
  const input = ProductionRuntimeApplicationInspection.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    const images = z
      .array(z.unknown())
      .length(1)
      .parse(
        JSON.parse(
          await runRuntimeHostDocker(
            ["image", "inspect", input.imageId],
            signal,
          ),
        ),
      );
    const containers = z
      .array(z.unknown())
      .length(1)
      .parse(
        JSON.parse(
          await runRuntimeHostDocker(
            ["container", "inspect", input.containerId],
            signal,
          ),
        ),
      );
    const result = inspectProductionApplicationContainer(
      containers[0],
      images[0],
      {
        deploymentId: input.deploymentId,
        projectId: input.projectId,
        resourceId: input.resourceId,
        containerId: input.containerId,
        imageId: input.imageId,
      },
    );
    lock.assertHeld();
    signal.throwIfAborted();
    return ProductionRuntimeApplicationReply.parse({
      version: 1,
      nonce: input.nonce,
      dockerId,
      ...result,
    });
  } catch {
    throw new Error(
      "Production application isolation could not be verified. Runtime credentials were not approved for delivery.",
    );
  } finally {
    await lock.release();
  }
}
