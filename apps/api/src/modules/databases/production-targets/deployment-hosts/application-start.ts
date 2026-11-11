/** Deliver a runtime role once to an exact stopped guardian; unknown results never trigger another start. */
import { z } from "zod";
import {
  ProductionRuntimeApplicationStart,
  ProductionRuntimeApplicationReply,
} from "@wrenly/db/production-host-contract";
import { applicationDatabaseEnvironment } from "@wrenly/sandbox/database-application-environment";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
import { inspectProductionApplicationContainer } from "./application-inspection";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
import {
  resolveRuntimeHostAddresses,
  type RuntimeHostLookup,
} from "./transport";
const READY_MARKER = "WRENLY_PRODUCTION_APPLICATION_READY_V1\n",
  MAX_REPLY_BYTES = 128;
/** Caller must retain its publishing lease and separately journal this start before invoking SSH. */
export async function startRuntimeApplication(
  raw: unknown,
  dockerId: string,
  parentSignal: AbortSignal,
  resolver?: RuntimeHostLookup,
): Promise<z.infer<typeof ProductionRuntimeApplicationReply>> {
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(30_000)]);
  const input = ProductionRuntimeApplicationStart.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  applicationDatabaseEnvironment(
    input.framework,
    input.resourceId,
    input.runtimeRole,
  );
  if (
    input.framework === "nextjs"
      ? input.appKey !== null
      : typeof input.appKey !== "string" ||
        !/^base64:[A-Za-z0-9+/]{43}=$/.test(input.appKey) ||
        Buffer.from(input.appKey.slice(7), "base64").toString("base64") !==
          input.appKey.slice(7)
  )
    throw new Error("Invalid runtime application key.");
  const checked = await inspectRuntimeDatabaseBroker(
    {
      version: 1,
      action: "inspect-runtime-broker",
      nonce: input.nonce,
      expectedDockerId: dockerId,
      deploymentId: input.deploymentId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      claimToken: input.claimToken,
      confirmDurableIntent: true,
      containerId: input.brokerId,
      imageId: input.brokerImageId,
      networkId: input.networkId,
      upstream: input.upstream,
    },
    dockerId,
    signal,
  );
  if (!checked.socketReady)
    throw new Error(
      "Production broker is not ready. No application credentials were sent.",
    );
  const lock = await acquireRuntimeHostLock(input.deploymentId);
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
    const [image] = z
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
    const [container] = z
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
    const scope = {
      deploymentId: input.deploymentId,
      projectId: input.projectId,
      resourceId: input.resourceId,
      containerId: input.containerId,
      imageId: input.imageId,
    };
    if (inspectProductionApplicationContainer(container, image, scope).running)
      throw new Error(
        "An active application requires inspection, never credential replay.",
      );
    lock.assertHeld();
    signal.throwIfAborted();
    await runRuntimeHostDocker(["start", input.containerId], signal);
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "attach",
        "--sig-proxy=false",
        input.containerId,
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent" },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    signal.addEventListener("abort", stop, { once: true });
    signal.throwIfAborted();
    if (
      !child.stdin ||
      typeof child.stdin === "number" ||
      !child.stdout ||
      typeof child.stdout === "number"
    )
      throw new Error("Guardian channels unavailable.");
    child.stdin.write(
      JSON.stringify({
        version: 1,
        framework: input.framework,
        resourceId: input.resourceId,
        role: input.runtimeRole,
        appKey: input.appKey,
      }),
    );
    child.stdin.end();
    const reader = child.stdout.getReader();
    let output = "";
    try {
      while (!output.includes("\n")) {
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) throw new Error("Guardian exited before readiness.");
        output += new TextDecoder().decode(part.value);
        if (Buffer.byteLength(output) > MAX_REPLY_BYTES)
          throw new Error("Unexpected guardian output.");
      }
    } finally {
      reader.releaseLock();
    }
    if (output !== READY_MARKER)
      throw new Error("Guardian readiness unconfirmed.");
    const [running] = z
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
    const result = inspectProductionApplicationContainer(running, image, scope);
    if (!result.running)
      throw new Error("Application stopped before acknowledgement.");
    await verifyTarget();
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
      "Production application startup could not be confirmed. Inspect the saved operation before retrying.",
    );
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
    await lock.release();
  }
}
