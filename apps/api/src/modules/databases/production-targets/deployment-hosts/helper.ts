/** Fixed host inspection entrypoint. It never loads instance settings or accepts shell commands. */
import {
  ProductionRuntimeHostInspection,
  ProductionRuntimeHostIdentity,
} from "@wrenly/db/production-host-contract";
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
export async function readRuntimeHostInspection(
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
    return ProductionRuntimeHostInspection.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } finally {
    deadline.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

if (import.meta.main) {
  try {
    const request = await readRuntimeHostInspection(Bun.stdin.stream());
    const reply = await inspectRuntimeHost(
      request,
      AbortSignal.timeout(INSPECTION_TIMEOUT_MS),
    );
    process.stdout.write(JSON.stringify(reply) + "\n");
  } catch {
    process.stderr.write("Deployment host inspection could not be verified.\n");
    process.exitCode = 1;
  }
}
