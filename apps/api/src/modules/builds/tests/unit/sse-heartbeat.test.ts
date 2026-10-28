import { expect, test } from "bun:test";
import { startSseHeartbeat } from "../../http/sse-heartbeat";

const TEST_INTERVAL_MS = 5;
const CLEANUP_OBSERVATION_MS = 20;

test("sends comment frames during quiet operations and stops after cleanup", async () => {
  const frames: string[] = [];
  let resolveFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const stop = startSseHeartbeat((frame) => {
    frames.push(frame);
    resolveFirst?.();
  }, TEST_INTERVAL_MS);
  try {
    await first;
    stop();
    const count = frames.length;
    await new Promise((resolve) => setTimeout(resolve, CLEANUP_OBSERVATION_MS));
    expect(frames[0]).toBe(": heartbeat\n\n");
    expect(frames.length).toBe(count);
  } finally {
    stop();
  }
});
