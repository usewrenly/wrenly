/**
 * Keeping a progress connection alive while work is quiet.
 * Sends periodic SSE comments, which carry no new build event or saved sequence.
 * Callers stop the timer when the subscription closes.
 */

const SSE_HEARTBEAT_INTERVAL_MS = 10_000;

/** Keeps the socket active without inventing execution progress. */
export function startSseHeartbeat(
  write: (frame: string) => void,
  intervalMs: number = SSE_HEARTBEAT_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => write(": heartbeat\n\n"), intervalMs);
  return (): void => clearInterval(timer);
}
