/**
 * Published application readiness probe
 * Used by publishing execution to distinguish a running job from the expected reachable revision.
 * Checks the public application and its deployment marker with one bounded deadline.
 * Sends no control-plane credentials and rejects redirects; a failed probe is not permission to redeploy.
 */
const REQUEST_TIMEOUT_MS = 5000;
const MAX_MARKER_BYTES = 128;
export type DeploymentReadinessReason =
  | "ready"
  | "invalid_target"
  | "application_http_error"
  | "marker_http_error"
  | "marker_too_large"
  | "marker_mismatch"
  | "network_error"
  | "aborted";

/** Checks a public runtime's exact deployment identity without forwarding control credentials. */
export async function verifyDeploymentReadiness(
  url: string,
  deploymentId: string,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
  report?: (reason: DeploymentReadinessReason) => void,
): Promise<boolean> {
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reason: DeploymentReadinessReason = "network_error";
  try {
    const application = new URL(url);
    if (
      !["http:", "https:"].includes(application.protocol) ||
      application.username ||
      application.password ||
      application.search ||
      application.hash ||
      !/^[a-f0-9-]{36}$/.test(deploymentId)
    ) {
      reason = "invalid_target";
      return false;
    }
    const deadline = AbortSignal.any([
      signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ]);
    response = await transport(application, {
      redirect: "error",
      credentials: "omit",
      signal: deadline,
      headers: { Accept: "text/html" },
    });
    if (!response.ok) {
      reason = "application_http_error";
      return false;
    }
    void response.body?.cancel().catch(() => {});
    response = await transport(
      new URL("/.well-known/wrenly-deployment", application),
      {
        redirect: "error",
        credentials: "omit",
        signal: deadline,
        headers: { Accept: "text/plain" },
      },
    );
    if (!response.ok || !response.body) {
      reason = "marker_http_error";
      return false;
    }
    if (Number(response.headers.get("content-length")) > MAX_MARKER_BYTES) {
      reason = "marker_too_large";
      return false;
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_MARKER_BYTES) {
        reason = "marker_too_large";
        return false;
      }
      chunks.push(chunk.value);
    }
    deadline.throwIfAborted();
    const matches = Buffer.concat(chunks).toString("utf8") === deploymentId;
    reason = matches ? "ready" : "marker_mismatch";
    return matches;
  } catch {
    reason = signal.aborted ? "aborted" : "network_error";
    return false;
  } finally {
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    } else void response?.body?.cancel().catch(() => {});
    report?.(reason);
  }
}
