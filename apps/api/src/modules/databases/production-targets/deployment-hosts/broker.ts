/** Fixed runtime-only database broker. Passwords and CA bytes travel on stdin, never Docker metadata. */
import { z } from "zod";
import { DATABASE_SOCKET_PATH } from "@wrenly/sandbox/database-resource-policy";
import {
  ProductionRuntimeBrokerRequest,
  ProductionRuntimeBrokerReply,
} from "@wrenly/db/production-host-contract";
import {
  productionDatabaseRuntimeSocketConfiguration,
  productionSocketHostMapping,
} from "@wrenly/sandbox/production-database-socket-policy";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
import {
  resolveRuntimeHostAddresses,
  type RuntimeHostLookup,
} from "./transport";
const READY_TIMEOUT_MS = 15000,
  POLL_MS = 100,
  MAX_CONFIGURATION_BYTES = 48 * 1024;
const Image = z.object({
  Id: z.string(),
  Config: z.object({
    User: z.literal("1000:1000"),
    Entrypoint: z.array(z.string()),
    Env: z.array(z.string()).nullable().optional(),
  }),
});
/** Call only after persisting the broker-creation intent and verifying the current publishing claim. Unknown results require inspection. */
export async function createRuntimeDatabaseBroker(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
  resolver?: RuntimeHostLookup,
): Promise<z.infer<typeof ProductionRuntimeBrokerReply>> {
  const input = ProductionRuntimeBrokerRequest.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const configuration = productionDatabaseRuntimeSocketConfiguration({
    resourceId: input.resourceId,
    runtimeRole: input.runtimeRole,
    upstream: input.upstream,
    certificateAuthority: input.certificateAuthority,
  });
  const payload = JSON.stringify(configuration);
  if (Buffer.byteLength(payload) > MAX_CONFIGURATION_BYTES)
    throw new Error("Broker settings exceed their limit.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  const name = `wrenly-deployment-broker-${input.deploymentId}`,
    volumeName = `wrenly-deployment-db-${input.deploymentId}`;
  const labels = {
    "io.wrenly.deployment-id": input.deploymentId,
    "io.wrenly.project-id": input.projectId,
    "io.wrenly.database-id": input.resourceId,
    "io.wrenly.database-environment": "production",
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = (): void => {
    if (child?.exitCode === null) child.kill("SIGKILL");
  };
  async function verifyTarget(): Promise<void> {
    const addresses = await resolveRuntimeHostAddresses(
      input.upstream.hostname,
      signal,
      resolver,
    );
    if (
      JSON.stringify(addresses) !== JSON.stringify(input.addresses) ||
      !addresses.includes(input.upstream.address)
    )
      throw new Error("Production addresses changed.");
  }
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    await verifyTarget();
    const image = Image.parse(
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
    if (
      image.Id !== input.imageId ||
      JSON.stringify(image.Config.Entrypoint) !==
        JSON.stringify(["bun", "--no-env-file", "/wrenly/entrypoint.ts"])
    )
      throw new Error("Broker toolchain changed.");
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
    if (
      volume.Name !== volumeName ||
      Object.keys(volume.Options ?? {}).length ||
      Object.entries({
        ...labels,
        "io.wrenly.role": "production-database-volume",
      }).some(([key, value]) => volume.Labels[key] !== value)
    )
      throw new Error("Broker socket storage changed.");
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
    if (
      network.Id !== input.networkId ||
      network.Name !== `wrenly-deployment-network-${input.deploymentId}` ||
      Object.keys(network.Options).length ||
      Object.keys(network.Containers ?? {}).length ||
      Object.entries({
        ...labels,
        "io.wrenly.role": "production-database-network",
      }).some(([key, value]) => network.Labels[key] !== value)
    )
      throw new Error("Broker network changed.");
    if (
      await runRuntimeHostDocker(
        [
          "container",
          "ls",
          "--all",
          "--filter",
          `name=^${name}$`,
          "--format",
          "{{.ID}}",
        ],
        signal,
      )
    )
      throw new Error("Existing broker requires inspection.");
    lock.assertHeld();
    signal.throwIfAborted();
    await verifyTarget();
    const containerId = await runRuntimeHostDocker(
      [
        "create",
        "--name",
        name,
        "--user",
        "1000:1000",
        "--network",
        input.networkId,
        "--read-only",
        "--interactive",
        "--restart",
        "no",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--pids-limit",
        "32",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--sysctl",
        "net.ipv4.ip_forward=0",
        "--add-host",
        productionSocketHostMapping(input.upstream),
        "--mount",
        `type=volume,src=${volumeName},dst=/run/wrenly-database`,
        "--tmpfs",
        "/run/wrenly-db-config:rw,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=0700",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=1m",
        "--health-cmd",
        `test -S ${DATABASE_SOCKET_PATH}`,
        "--health-interval",
        "1s",
        "--health-timeout",
        "1s",
        "--health-retries",
        "3",
        "--log-driver",
        "none",
        ...Object.entries({
          ...labels,
          "io.wrenly.role": "production-database-broker",
        }).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        input.imageId,
      ],
      signal,
    );
    if (!/^[a-f0-9]{64}$/.test(containerId))
      throw new Error("Broker creation unconfirmed.");
    lock.assertHeld();
    signal.throwIfAborted();
    await runRuntimeHostDocker(["start", containerId], signal);
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "attach",
        "--sig-proxy=false",
        containerId,
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent" },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    signal.addEventListener("abort", stop, { once: true });
    signal.throwIfAborted();
    if (!child.stdin || typeof child.stdin === "number")
      throw new Error("Broker input unavailable.");
    child.stdin.write(payload);
    child.stdin.end();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (true) {
      lock.assertHeld();
      signal.throwIfAborted();
      const state = z
        .array(
          z.object({
            Id: z.string(),
            Image: z.string(),
            State: z.object({
              Running: z.boolean(),
              Health: z.object({ Status: z.string() }).optional(),
            }),
          }),
        )
        .length(1)
        .parse(
          JSON.parse(
            await runRuntimeHostDocker(
              ["container", "inspect", containerId],
              signal,
            ),
          ),
        )[0]!;
      if (
        state.Id !== containerId ||
        state.Image !== input.imageId ||
        !state.State.Running ||
        Date.now() > deadline
      )
        throw new Error("Broker readiness unconfirmed.");
      if (state.State.Health?.Status === "healthy") break;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    }
    await verifyTarget();
    lock.assertHeld();
    signal.throwIfAborted();
    return ProductionRuntimeBrokerReply.parse({
      version: 1,
      nonce: input.nonce,
      dockerId,
      containerId,
      imageId: input.imageId,
      networkId: input.networkId,
      volumeName,
    });
  } catch {
    throw new Error(
      "Production runtime broker could not be confirmed. Inspect the saved operation before continuing.",
    );
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
    await lock.release();
  }
}
