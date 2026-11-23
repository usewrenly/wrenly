/** Trusted network-facing process. Its only upstream is the deployment-owned application Unix socket. */
import { startRuntimeRelay } from "./relay";
const APPLICATION_HTTP_SOCKET = "/run/wrenly-http/http.sock";
const INGRESS_PORT = 3000;
/** Runs only as the isolated ingress container's unprivileged PID1; it never reads database credentials. */
export async function runDeploymentIngress(): Promise<void> {
  if (
    process.pid !== 1 ||
    process.getuid?.() !== 1000 ||
    process.argv.length > 2
  )
    throw new Error("Invalid deployment ingress context.");
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const relay = await startRuntimeRelay({
      listen: { host: "0.0.0.0", port: INGRESS_PORT },
      destination: { path: APPLICATION_HTTP_SOCKET },
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });
    await relay.close();
  } finally {
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}
