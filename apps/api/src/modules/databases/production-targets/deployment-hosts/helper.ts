/** Fixed deployment-host entrypoint. It never loads instance settings or accepts shell commands. */
import {
  ProductionRuntimeHostInspection,
  ProductionRuntimeHostIdentity,
  ProductionRuntimeHostRequest,
} from "@wrenly/db/production-host-contract";
import { executeRuntimeVolumeRequest } from "./volumes";
import { executeRuntimeNetworkRequest } from "./network";
import {
  findRuntimeApplication,
  verifyRuntimeApplicationReady,
  executeRuntimeApplicationInspection,
} from "./application-inspection";
import { createRuntimeDatabaseBroker } from "./broker";
import { findRuntimeDatabaseBroker } from "./broker-discovery";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
import { findRuntimeIngress } from "./ingress-inspection";
import { restartRuntimeDatabaseBroker } from "./broker-restart";
import { startRuntimeApplication } from "./application-start";
const MAX_OPERATION_MS = 30_000;
const MAX_INPUT_BYTES = 128 * 1024;
const MAX_DOCKER_OUTPUT_BYTES = 16 * 1024;
const INSPECTION_TIMEOUT_MS = 5_000;

/** Checks the local daemon through the explicit socket; caller-supplied Docker contexts cannot retarget it. */
export async function inspectRuntimeHost(
  request: unknown,
  signal: AbortSignal,
): Promise<ProductionRuntimeHostIdentity> {
  const input = ProductionRuntimeHostInspection.parse(request);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(INSPECTION_TIMEOUT_MS),
  ]);
  const stop = (): void => {
    if (child?.exitCode === null) child.kill("SIGKILL");
  };
  try {
    deadline.throwIfAborted();
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "info",
        "--format",
        "{{json .}}",
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    deadline.addEventListener("abort", stop, { once: true });
    deadline.throwIfAborted();
    if (!child.stdout || typeof child.stdout === "number")
      throw new Error("Host output channel unavailable.");
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        deadline.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_DOCKER_OUTPUT_BYTES)
          throw new Error("Host inspection output exceeds its limit.");
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if ((await child.exited) !== 0) throw new Error("Host inspection failed.");
    const facts: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!facts || typeof facts !== "object")
      throw new Error("Invalid daemon identity.");
    const values = facts as Record<string, unknown>;
    return ProductionRuntimeHostIdentity.parse({
      version: 1,
      nonce: input.nonce,
      dockerId: values.ID,
      operatingSystem: values.OSType,
      architecture: values.Architecture,
      helperVersion: 1,
    });
  } catch {
    throw new Error("Deployment host inspection could not be verified.");
  } finally {
    deadline.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
  }
}

/** Reads one bounded request. Unknown actions and extra fields fail before any daemon access. */
export async function readRuntimeHostRequest(
  stream: ReadableStream<Uint8Array>,
): Promise<unknown> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const deadline = AbortSignal.timeout(INSPECTION_TIMEOUT_MS);
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  deadline.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const part = await reader.read();
      deadline.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_INPUT_BYTES)
        throw new Error("Host request exceeds its limit.");
      chunks.push(part.value);
    }
    return ProductionRuntimeHostRequest.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } finally {
    deadline.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

if (import.meta.main) {
  try {
    const request = await readRuntimeHostRequest(Bun.stdin.stream());
    const input = ProductionRuntimeHostRequest.parse(request);
    const signal = AbortSignal.timeout(MAX_OPERATION_MS);
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: input.nonce },
      signal,
    );
    const reply =
      input.action === "inspect"
        ? host
        : input.action === "find-runtime-broker"
          ? await findRuntimeDatabaseBroker(input, host.dockerId, signal)
          : input.action === "verify-runtime-application-ready"
            ? await verifyRuntimeApplicationReady(input, host.dockerId, signal)
            : input.action === "restart-runtime-broker"
              ? await restartRuntimeDatabaseBroker(input, host.dockerId, signal)
              : input.action === "find-runtime-ingress"
                ? await findRuntimeIngress(input, host.dockerId, signal)
                : input.action === "find-runtime-application"
                  ? await findRuntimeApplication(input, host.dockerId, signal)
                  : input.action === "start-runtime-application"
                    ? await startRuntimeApplication(
                        input,
                        host.dockerId,
                        signal,
                      )
                    : input.action === "create-runtime-broker"
                      ? await createRuntimeDatabaseBroker(
                          input,
                          host.dockerId,
                          signal,
                        )
                      : input.action === "inspect-runtime-broker"
                        ? await inspectRuntimeDatabaseBroker(
                            input,
                            host.dockerId,
                            signal,
                          )
                        : input.action === "inspect-runtime-application"
                          ? await executeRuntimeApplicationInspection(
                              input,
                              host.dockerId,
                              signal,
                            )
                          : input.action === "create-runtime-network" ||
                              input.action === "inspect-runtime-network"
                            ? await executeRuntimeNetworkRequest(
                                input,
                                host.dockerId,
                                signal,
                              )
                            : await executeRuntimeVolumeRequest(
                                input,
                                host.dockerId,
                                signal,
                              );
    process.stdout.write(JSON.stringify(reply) + "\n");
  } catch {
    process.stderr.write("Deployment host inspection could not be verified.\n");
    process.exitCode = 1;
  }
}
