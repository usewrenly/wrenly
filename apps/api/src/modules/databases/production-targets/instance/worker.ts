/** A single owner-confirmed app-server verification. Importing this module starts no worker. */
import type { db } from "@wrenly/db";
import {
  claimInstanceProductionConnection,
  loadInstanceProductionConnection,
  finishInstanceProductionConnection,
  type InstanceConnectionReceipt,
} from "./store";
import { readControlIdentity } from "../setup/verification-worker";
import { pinProductionDatabaseTarget } from "../target-policy";
import { inspectAuthenticatedProductionTarget } from "../authenticated-inspection";
const VERIFICATION_DEADLINE_MS = 30_000;
/** Saves pinned authenticated facts once; failed persistence is unknown state, not a reason to repeat the check. */
export async function runInstanceProductionConnectionOnce(input: {
  database: typeof db;
  directory: string;
  controlDatabaseUrl: string;
  signal?: AbortSignal;
}): Promise<InstanceConnectionReceipt | null> {
  input.signal?.throwIfAborted();
  const claim = await claimInstanceProductionConnection(input.database);
  if (!claim) return null;
  const signal = AbortSignal.any([
    AbortSignal.timeout(VERIFICATION_DEADLINE_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  let outcome: Parameters<typeof finishInstanceProductionConnection>[2];
  try {
    const saved = await loadInstanceProductionConnection(
      input.database,
      claim,
      input.directory,
    );
    const controlClusterId = await readControlIdentity(input.database);
    signal.throwIfAborted();
    const pinned = await pinProductionDatabaseTarget(
      saved.target,
      input.controlDatabaseUrl,
      { signal },
    );
    const inspection = await inspectAuthenticatedProductionTarget({
      ...saved,
      target: pinned,
      controlClusterId,
      controlDatabaseUrl: input.controlDatabaseUrl,
      signal,
    });
    signal.throwIfAborted();
    outcome = { status: "verified", inspection, pinned };
  } catch {
    outcome = { status: signal.aborted ? "interrupted" : "refused" };
  }
  try {
    return await finishInstanceProductionConnection(
      input.database,
      claim,
      outcome,
    );
  } catch {
    throw new Error(
      "Connection check completion could not be confirmed. Reload its saved status before continuing.",
    );
  }
}
