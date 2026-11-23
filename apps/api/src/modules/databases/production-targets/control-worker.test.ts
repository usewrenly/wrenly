import { expect, test } from "bun:test";
import {
  startProductionControlWorker,
  type ProductionControlStages,
} from "./control-worker";
test("shutdown aborts and awaits active Production control work before any next stage", async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  const worker = startProductionControlWorker({
    stages: {
      connection: async (signal) => {
        calls.push("connection");
        entered();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          if (signal.aborted) resolve();
        });
        await released;
        return true;
      },
      host: async () => {
        calls.push("host");
        return false;
      },
      review: async () => false,
      handoff: async () => false,
      provision: async () => false,
    },
    log: () => {
      throw new Error("shutdown must not log failure");
    },
  });
  await started;
  let stopped = false;
  const stop = worker.stop().then(() => {
    stopped = true;
  });
  await Bun.sleep(5);
  expect(stopped).toBe(false);
  finish();
  await stop;
  expect(calls).toEqual(["connection"]);
  await worker.stop();
});
test("a refused setup stage does not suppress other saved queues and an idle worker stops promptly", async () => {
  const calls: string[] = [],
    failures: string[] = [];
  let done!: () => void;
  const reached = new Promise<void>((resolve) => {
    done = resolve;
  });
  const stages: ProductionControlStages = {
    connection: async () => {
      calls.push("connection");
      throw new Error("private fixture detail");
    },
    host: async () => {
      calls.push("host");
      return false;
    },
    review: async () => {
      calls.push("review");
      return false;
    },
    handoff: async () => {
      calls.push("handoff");
      return false;
    },
    provision: async () => {
      calls.push("provision");
      done();
      return false;
    },
  };
  const worker = startProductionControlWorker({
    stages,
    log: (stage) => {
      failures.push(stage);
    },
    pollMs: 1000,
  });
  await reached;
  await worker.stop();
  expect(calls).toEqual([
    "connection",
    "host",
    "review",
    "handoff",
    "provision",
  ]);
  expect(failures).toEqual(["connection"]);
});
