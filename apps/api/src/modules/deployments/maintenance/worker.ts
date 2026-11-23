/** One held maintenance attempt; scheduling is separate from browser requests and never reclaims interrupted work. */
import type { db } from "@wrenly/db";
import {
  executeMaintenance,
  type MaintenanceExecutionServices,
} from "./executor";
import { renewMaintenance, type MaintenanceClaim } from "./claims";
import { acquireDeploymentExecutorLock } from "../execution/deployment-executor-lock";
const RENEW_MS = 5000;
/** Waits for the owned adapter before returning. On failure its persisted pending effect remains unresolved. */
export async function runMaintenanceClaim(input: {
  database: typeof db;
  claim: MaintenanceClaim;
  signal: AbortSignal;
  services: (assertHeld: () => Promise<void>) => MaintenanceExecutionServices;
}): Promise<void> {
  const lock = await acquireDeploymentExecutorLock({
    deploymentId: input.claim.deploymentId,
    token: input.claim.token,
  });
  const lost = new AbortController(),
    signal = AbortSignal.any([input.signal, lost.signal]);
  let stopped = false;
  let renewing: Promise<void> | undefined;
  const assertHeld = async (): Promise<void> => {
    lock.assertHeld();
    signal.throwIfAborted();
    // The heartbeat and an adapter may check simultaneously. Share that renewal
    // rather than contending with our own transaction's non-waiting queue locks.
    if (!renewing)
      renewing = renewMaintenance(input.database, input.claim).finally(() => {
        renewing = undefined;
      });
    await renewing;
    lock.assertHeld();
    signal.throwIfAborted();
  };
  const renewal = (async (): Promise<void> => {
    while (!stopped && !signal.aborted) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, RENEW_MS);
        function done(): void {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          resolve();
        }
        signal.addEventListener("abort", done, { once: true });
        if (signal.aborted) done();
      });
      if (stopped || signal.aborted) break;
      try {
        await assertHeld();
      } catch {
        lost.abort();
      }
    }
  })();
  try {
    await assertHeld();
    await executeMaintenance(input.services(assertHeld), signal);
  } finally {
    stopped = true;
    lost.abort();
    await renewal;
    await lock.release();
  }
}
