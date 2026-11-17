import { expect, test } from "bun:test";
import { startMaintenanceScheduler } from "./scheduler";
const claim = {
  id: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  deploymentId: crypto.randomUUID(),
  grantRevision: crypto.randomUUID(),
  token: crypto.randomUUID(),
};
test("shutdown waits for its held attempt and never admits a second while it runs", async () => {
  let claimed = 0,
    settled = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const worker = startMaintenanceScheduler(
    {
      page: async () => [
        { deploymentId: claim.deploymentId, revision: claim.grantRevision },
      ],
      claim: async () => {
        claimed++;
        return claim;
      },
      run: async (_claim, signal) => {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        settled = true;
      },
      failed: () => {
        throw new Error("unexpected failure");
      },
    },
    1,
  );
  await ready;
  await worker.stop();
  expect(settled).toBe(true);
  expect(claimed).toBe(1);
});
test("inactive grants and blocked attempts never reach a host adapter; cursor advances", async () => {
  let called = 0,
    pages = 0;
  let visited!: () => void;
  const ready = new Promise<void>((resolve) => {
    visited = resolve;
  });
  const worker = startMaintenanceScheduler(
    {
      page: async (after) => {
        pages++;
        if (pages === 1)
          return [{ deploymentId: claim.deploymentId, revision: "" }];
        expect(after).toBe(claim.deploymentId);
        visited();
        return [];
      },
      claim: async () => {
        called++;
        return null;
      },
      run: async () => {
        throw new Error("must not execute");
      },
      failed: () => {},
    },
    1,
  );
  await ready;
  await worker.stop();
  expect(called).toBe(0);
});
