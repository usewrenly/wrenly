import { describe, expect, test } from "bun:test";
import {
  runConversationWorkerCycle,
  runConversationWorker,
  type ConversationWorkerDependencies,
} from "../../execution/conversation-worker";
import { ConversationModelError } from "../../execution/conversation-model";
import type { ConversationClaim } from "../../persistence/conversation-store";
import type { ConversationDecision } from "../../contracts/contracts";

function fixture(): {
  dependencies: ConversationWorkerDependencies;
  saved: string[];
  claim: ConversationClaim;
} {
  const saved: string[] = [];
  const claim: ConversationClaim = {
    turnId: crypto.randomUUID(),
    token: crypto.randomUUID(),
    input: {
      conversationId: crypto.randomUUID(),
      prompt: "Explain",
      mode: "ask",
      baseBuildId: null,
      model: "model",
      provider: "provider",
    },
  };
  return {
    saved,
    claim,
    dependencies: {
      claim: async () => claim,
      recover: async () => false,
      renew: async () => true,
      context: async () => ({
        project: { name: "Fixture", stack: "nextjs" },
        messages: [],
        revision: null,
      }),
      infer: async () => ({ type: "answer", content: "Saved explanation" }),
      complete: async () => {
        saved.push("completed");
      },
      fail: async (_, status, message) => {
        saved.push(status, message);
      },
    },
  };
}
const timing = { monitorMs: 5, pollMs: 5, deadlineMs: 1000 };
function waitForAbort(signal: AbortSignal): Promise<ConversationDecision> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

describe("durable conversation worker", () => {
  test("persists one response after pre/post inference ownership checks", async () => {
    const f = fixture();
    let renewals = 0;
    f.dependencies.renew = async () => {
      renewals++;
      return true;
    };
    expect(
      await runConversationWorkerCycle(
        f.dependencies,
        new AbortController().signal,
        timing,
      ),
    ).toBe(true);
    expect(f.saved).toEqual(["completed"]);
    expect(renewals).toBe(2);
  });
  test("provider failure is saved safely without a fake assistant answer or retry", async () => {
    const f = fixture();
    let calls = 0;
    f.dependencies.infer = async () => {
      calls++;
      throw new ConversationModelError("The provider is unavailable.");
    };
    await runConversationWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(calls).toBe(1);
    expect(f.saved).toEqual(["failed", "The provider is unavailable."]);
  });
  test("deadline aborts inference and persists a failed outcome", async () => {
    const f = fixture();
    f.dependencies.infer = async (_, __, signal) => waitForAbort(signal);
    await runConversationWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      { ...timing, deadlineMs: 10 },
    );
    expect(f.saved[0]).toBe("failed");
    expect(f.saved[1]).toContain("deadline");
  });
  test("shutdown settles inference and persists interrupted rather than failed", async () => {
    const f = fixture();
    const shutdown = new AbortController();
    f.dependencies.infer = async (_, __, signal) => {
      setTimeout(() => shutdown.abort(), 5);
      return waitForAbort(signal);
    };
    await runConversationWorkerCycle(f.dependencies, shutdown.signal, timing);
    expect(f.saved[0]).toBe("interrupted");
  });
  test("lost lease aborts without attempting a stale completion or failure write", async () => {
    const f = fixture();
    let renewals = 0;
    f.dependencies.renew = async () => ++renewals < 2;
    f.dependencies.infer = async (_, __, signal) => waitForAbort(signal);
    await runConversationWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      timing,
    );
    expect(f.saved).toEqual([]);
  });
  test("does not advance execution until an aborting adapter has settled", async () => {
    const f = fixture();
    let settled = false;
    f.dependencies.infer = async (_, __, signal) => {
      try {
        await waitForAbort(signal);
      } catch {
        await Bun.sleep(20);
        settled = true;
        throw new Error("Aborted");
      }
      throw new Error("Unexpected");
    };
    await runConversationWorkerCycle(
      f.dependencies,
      new AbortController().signal,
      { ...timing, deadlineMs: 5 },
    );
    expect(settled).toBe(true);
    expect(f.saved[0]).toBe("failed");
  });
  test("recovers interrupted work before claiming and wakes quiet polling on stop", async () => {
    const f = fixture();
    const order: string[] = [];
    const shutdown = new AbortController();
    f.dependencies.recover = async () => {
      order.push("recover");
      return order.length === 1;
    };
    f.dependencies.claim = async () => {
      order.push("claim");
      shutdown.abort();
      return null;
    };
    await runConversationWorker(f.dependencies, shutdown.signal, 1000, timing);
    expect(order).toEqual(["recover", "recover", "claim"]);
    expect(f.saved).toEqual([]);
  });
});
