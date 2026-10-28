import { expect, test } from "bun:test";
import {
  startDatabaseWorker,
  type DatabaseWorkerDependencies,
} from "./database-worker";
import type { DatabaseClaim } from "./database-store";
const claim: DatabaseClaim = {
  id: crypto.randomUUID(),
  resourceId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  token: crypto.randomUUID(),
};
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function dependencies(): DatabaseWorkerDependencies {
  let claimed = false;
  return {
    recoverExpired: async () => {},
    claim: async () => {
      if (claimed) return null;
      claimed = true;
      return claim;
    },
    renew: async () => {},
    execute: async () => "success",
    interrupt: async () => {},
    log: () => {},
    pollMs: 1,
    heartbeatMs: 2,
  };
}
test("database worker completes one admitted operation and never replays it", async () => {
  const complete = deferred(),
    input = dependencies();
  let executions = 0;
  input.execute = async () => {
    executions++;
    return "success";
  };
  input.log = (message) => {
    if (message === "Database execution finished") complete.resolve();
  };
  const worker = startDatabaseWorker(input);
  await complete.promise;
  await worker.stop();
  expect(executions).toBe(1);
});
test("shutdown waits for execution cleanup before recording interruption", async () => {
  const started = deferred(),
    aborted = deferred(),
    cleanup = deferred(),
    input = dependencies();
  let interrupted = 0,
    stopped = false;
  input.execute = async (_claim, signal) => {
    started.resolve();
    signal.addEventListener("abort", aborted.resolve, { once: true });
    await aborted.promise;
    await cleanup.promise;
    throw new Error("Stopped");
  };
  input.interrupt = async () => {
    interrupted++;
  };
  const worker = startDatabaseWorker(input);
  await started.promise;
  const stop = worker.stop().then(() => {
    stopped = true;
  });
  await aborted.promise;
  expect(interrupted).toBe(0);
  expect(stopped).toBe(false);
  cleanup.resolve();
  await stop;
  expect(interrupted).toBe(1);
  expect(stopped).toBe(true);
});
test("lease loss aborts execution and unknown results are not automatically retried or logged", async () => {
  const complete = deferred(),
    input = dependencies(),
    logs: string[] = [];
  let executions = 0,
    renewals = 0;
  input.renew = async () => {
    renewals++;
    throw new Error("Secret provider response must not be logged");
  };
  input.execute = async (_claim, signal) => {
    executions++;
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });
    throw new Error("Secret provider response must not be logged");
  };
  input.interrupt = async () => {
    complete.resolve();
  };
  input.log = (message, context) => {
    logs.push(JSON.stringify({ message, context }));
  };
  const worker = startDatabaseWorker(input);
  await complete.promise;
  await worker.stop();
  expect(executions).toBe(1);
  expect(renewals).toBeGreaterThan(0);
  expect(logs.join("")).not.toContain("Secret provider");
});
test("claim racing shutdown is interrupted before any external execution", async () => {
  const started = deferred(),
    finishClaim = deferred(),
    input = dependencies();
  let executions = 0,
    interruptions = 0;
  input.claim = async () => {
    started.resolve();
    await finishClaim.promise;
    return claim;
  };
  input.execute = async () => {
    executions++;
    return "success";
  };
  input.interrupt = async () => {
    interruptions++;
  };
  const worker = startDatabaseWorker(input);
  await started.promise;
  const stop = worker.stop();
  finishClaim.resolve();
  await stop;
  expect(executions).toBe(0);
  expect(interruptions).toBe(1);
});
