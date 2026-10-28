import { describe, expect, test } from "bun:test";
import { createBuildLogBatcher } from "../../http/build-log-batcher";

describe("live log persistence", () => {
  test("keeps split lines together and drains the final partial line once", async () => {
    const saved: string[] = [];
    const logs = createBuildLogBatcher(
      async (text) => {
        saved.push(text);
      },
      () => {},
    );
    logs.write("Comp");
    logs.write("iling\nDone");
    await logs.drain();
    expect(saved).toEqual(["Compiling\nDone"]);
  });
  test("serializes slow writes and preserves text arriving during persistence", async () => {
    const saved: string[] = [];
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    const logs = createBuildLogBatcher(
      async (text) => {
        saved.push(text);
        if (saved.length === 1) {
          started();
          await gate;
        }
      },
      () => {},
    );
    logs.write("First\n");
    await begun;
    logs.write("Second\n");
    const drained = logs.drain();
    release();
    await drained;
    expect(saved).toEqual(["First", "Second"]);
  });
  test("bounds noisy output with a visible truncation notice", async () => {
    const saved: string[] = [];
    const logs = createBuildLogBatcher(
      async (text) => {
        saved.push(text);
      },
      () => {},
    );
    logs.write("x".repeat(100_000));
    await logs.drain();
    expect(saved[0]?.length).toBeLessThanOrEqual(64_000);
    expect(saved[0]).toContain("truncated");
  });
  test("reports write failure, stops delivery, and rejects drain", async () => {
    let failures = 0;
    let calls = 0;
    const logs = createBuildLogBatcher(
      async () => {
        calls++;
        throw new Error("Database unavailable");
      },
      () => {
        failures++;
      },
    );
    logs.write("Partial output\n");
    await expect(logs.drain()).rejects.toThrow("persistence failed");
    logs.write("Never persisted");
    expect(calls).toBe(1);
    expect(failures).toBe(1);
  });
});
