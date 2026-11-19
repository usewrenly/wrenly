/** Bounded fixed-helper Docker transport; request schemas, never callers, determine the argument list. */
const MAX_OUTPUT_BYTES = 128 * 1024;
const COMMAND_TIMEOUT_MS = 10_000;
/** Internal helper only. No shell, ambient Docker context, inherited credentials or raw stderr is used. */
export async function runRuntimeHostDocker(
  arguments_: string[],
  signal: AbortSignal,
): Promise<string> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  ]);
  const stop = (): void => {
    if (child?.exitCode === null) child.kill("SIGKILL");
  };
  try {
    deadline.throwIfAborted();
    child = Bun.spawn(
      ["docker", "--host", "unix:///var/run/docker.sock", ...arguments_],
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
      throw new Error("Docker output unavailable.");
    const reader = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        deadline.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES)
          throw new Error("Docker output exceeds its limit.");
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    if ((await child.exited) !== 0)
      throw new Error("Docker command did not complete.");
    deadline.throwIfAborted();
    return Buffer.concat(chunks).toString("utf8").trim();
  } catch {
    throw new Error("Deployment host Docker operation could not be confirmed.");
  } finally {
    deadline.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
  }
}
