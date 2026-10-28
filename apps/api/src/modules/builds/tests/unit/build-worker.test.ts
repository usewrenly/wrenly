import { describe, expect, test } from "bun:test";
import { BuildExecutionInterruptedError } from "../../execution/build-interruption";

test("database interruption is saved after cleanup instead of reported as an ordinary failed build", async () => {
  const f = fixture();
  f.dependencies.execute = async () => { f.calls.push("execute"); throw new BuildExecutionInterruptedError(); };
  await runBuildWorkerCycle(f.dependencies, new AbortController().signal, timing);
  expect(f.outcomes[0]?.status).toBe("interrupted");
  expect(f.calls.indexOf("cleanup")).toBeLessThan(f.calls.indexOf("finish"));
});
import {
  runBuildWorker,
  runBuildWorkerCycle,
  type BuildWorkerDependencies,
} from "../../execution/build-worker";
import type {
  BuildClaim,
  BuildOutcome,
} from "../../persistence/build-job-store";

const claim: BuildClaim = {
  buildId: "build",
  projectId: "project",
  token: "token",
  input: {
    prompt: "Build",
    stack: "nextjs",
    model: "test-model",
    provider: "test-provider",
    previousFiles: [],
    previousErrors: [],
  },
};
const timing = { monitorIntervalMs: 5, pollIntervalMs: 5 };
function fixture(): {
  dependencies: BuildWorkerDependencies;
  calls: string[];
  outcomes: BuildOutcome[];
} {
  const calls: string[] = [];
  const outcomes: BuildOutcome[] = [];
  const dependencies: BuildWorkerDependencies = {
    claim: async () => {
      calls.push("claim");
      return claim;
    },
    renew: async () => {
      calls.push("renew");
      return true;
    },
    cancellationRequested: async () => false,
    reconcile: async () => {
      calls.push("reconcile");
      return false;
    },
    execute: async () => {
      calls.push("execute");
      return { status: "success" };
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    finish: async (_claim, outcome) => {
      calls.push("finish");
      outcomes.push(outcome);
    },
  };
  return { dependencies, calls, outcomes };
}
function untilAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

describe("bounded build worker", () => {
  test("reconciles before claiming and cleans resources before finishing", async () => {
    const f = fixture();
    expect(
      await runBuildWorkerCycle(f.dependencies, new AbortController().signal),
    ).toBe(true);
    expect(f.calls).toEqual([
      "reconcile",
      "claim",
      "renew",
      "execute",
      "cleanup",
      "finish",
    ]);
    expect(f.outcomes).toEqual([{ status: "success" }]);
  });
  test("does not claim after shutdown or run external work without ownership", async () => {
    const f = fixture();
    const shutdown = new AbortController();
    shutdown.abort();
    expect(await runBuildWorkerCycle(f.dependencies, shutdown.signal)).toBe(
      false,
    );
    expect(f.calls).toEqual([]);
    f.dependencies.renew = async () => false;
    await runBuildWorkerCycle(f.dependencies, new AbortController().signal);
    expect(f.calls).not.toContain("execute");
    expect(f.calls).toContain("cleanup");
    expect(f.outcomes).toEqual([]);
  });
  test("failed recovery prevents new claims", async () => {
    const f = fixture();
    f.dependencies.reconcile = async () => {
      throw new Error("Cleanup unavailable");
    };
    await expect(
      runBuildWorkerCycle(f.dependencies, new AbortController().signal),
    ).rejects.toThrow("Cleanup unavailable");
    expect(f.calls).not.toContain("claim");
  });
  test("abort on lease loss stops execution and never commits a terminal write", async () => {
    const f = fixture();
    let renewals = 0;
    f.dependencies.renew = async () => ++renewals === 1;
    f.dependencies.execute = async (_claim, signal) => untilAbort(signal);
    await runBuildWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(renewals).toBe(2);
    expect(f.calls).toContain("cleanup");
    expect(f.outcomes).toEqual([]);
  });
  test("persisted cancellation aborts execution, cleans up and finishes cancelled", async () => {
    const f = fixture();
    let checks = 0;
    f.dependencies.cancellationRequested = async () => ++checks > 1;
    f.dependencies.execute = async (_claim, signal) => untilAbort(signal);
    await runBuildWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(f.outcomes).toEqual([{ status: "cancelled" }]);
    expect(f.calls.indexOf("cleanup")).toBeLessThan(f.calls.indexOf("finish"));
  });
  test("shutdown aborts active execution and records interruption after cleanup", async () => {
    const f = fixture();
    const shutdown = new AbortController();
    f.dependencies.execute = async (_claim, signal) => {
      shutdown.abort();
      return untilAbort(signal);
    };
    await runBuildWorkerCycle(f.dependencies, shutdown.signal);
    expect(f.outcomes[0]?.status).toBe("interrupted");
  });
  test("unknown ownership after monitor failure aborts without committing failure", async () => {
    const f = fixture();
    let renewals = 0;
    f.dependencies.renew = async () => {
      if (++renewals > 1) throw new Error("Database unavailable");
      return true;
    };
    f.dependencies.execute = async (_claim, signal) => untilAbort(signal);
    await runBuildWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(f.outcomes).toEqual([]);
    expect(f.calls).toContain("cleanup");
  });
  test("failed cleanup leaves the claim for recovery rather than releasing capacity", async () => {
    const f = fixture();
    f.dependencies.cleanup = async () => {
      throw new Error("Container still running");
    };
    await expect(
      runBuildWorkerCycle(f.dependencies, new AbortController().signal),
    ).rejects.toThrow("Container still running");
    expect(f.outcomes).toEqual([]);
  });
  test("execution errors produce safe failure only after cleanup", async () => {
    const f = fixture();
    f.dependencies.execute = async () => {
      throw new Error("Private provider details");
    };
    await runBuildWorkerCycle(f.dependencies, new AbortController().signal);
    expect(f.outcomes[0]?.status).toBe("failed");
    expect(JSON.stringify(f.outcomes)).not.toContain(
      "Private provider details",
    );
    expect(f.calls.indexOf("cleanup")).toBeLessThan(f.calls.indexOf("finish"));
  });
  test("poll loop stops during idle wait without claiming again", async () => {
    const f = fixture();
    const shutdown = new AbortController();
    f.dependencies.claim = async () => {
      f.calls.push("claim");
      queueMicrotask(() => shutdown.abort());
      return null;
    };
    await runBuildWorker(f.dependencies, shutdown.signal, timing);
    expect(f.calls.filter((call) => call === "claim")).toHaveLength(1);
  });
  test("slow initial renewal cannot overlap timer-driven renewal", async () => {
    const f = fixture();
    let active = 0;
    let maximum = 0;
    f.dependencies.renew = async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return true;
    };
    await runBuildWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(maximum).toBe(1);
  });
  test("renews ownership while waiting for resource cleanup", async () => {
    const f = fixture();
    let renewals = 0;
    let releaseCleanup: () => void = () => {};
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    f.dependencies.renew = async () => {
      if (++renewals > 1) releaseCleanup();
      return true;
    };
    f.dependencies.cleanup = async () => {
      await cleanupReleased;
      f.calls.push("cleanup");
    };
    await runBuildWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(renewals).toBeGreaterThanOrEqual(2);
    expect(f.outcomes).toEqual([{ status: "success" }]);
  });
  test("claim racing shutdown cleans up without starting generation", async () => {
    const f = fixture();
    const shutdown = new AbortController();
    f.dependencies.claim = async () => {
      shutdown.abort();
      return claim;
    };
    await runBuildWorkerCycle(f.dependencies, shutdown.signal);
    expect(f.calls).not.toContain("execute");
    expect(f.calls).toContain("cleanup");
    expect(f.outcomes[0]?.status).toBe("interrupted");
  });
});
