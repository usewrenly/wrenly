/** Read-only recovery inspection holds the same resource lock as creation; it never replays provisioning SQL. */
import type { db } from "@wrenly/db";
import {
  inspectProductionProjectPhase,
  type ProductionPhaseInspection,
} from "@wrenly/db/production-project-recovery";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import { readControlIdentity } from "../setup/verification-worker";
import { withPinnedProductionManagement } from "../management-connection";
import {
  claimProductionProvisionReview,
  loadProductionProvisionReview,
  finishProductionProvisionReview,
  type ProductionProvisionReviewReceipt,
} from "./recovery-store";
/** One saved inspection produces safe facts only; owner confirmation of continuation is a different action. */
export async function runProductionProvisionReviewOnce(input: {
  database: typeof db;
  directory: string;
  controlDatabaseUrl: string;
  signal: AbortSignal;
}): Promise<ProductionProvisionReviewReceipt | null> {
  input.signal.throwIfAborted();
  const claim = await claimProductionProvisionReview(input.database);
  if (!claim) return null;
  const lock = await acquireDatabaseExecutorLock({
    id: claim.id,
    resourceId: claim.resourceId,
    projectId: claim.projectId,
    token: claim.token,
  });
  try {
    let outcome: ProductionPhaseInspection | "interrupted";
    try {
      const saved = await loadProductionProvisionReview(
        input.database,
        claim,
        input.directory,
      );
      const controlClusterId = await readControlIdentity(input.database);
      lock.assertHeld();
      input.signal.throwIfAborted();
      outcome = await withPinnedProductionManagement({
        target: {
          target: {
            ...saved.server.target,
            database:
              saved.phase === "schema"
                ? saved.credentials.database
                : saved.server.target.database,
          },
          addresses: saved.server.addresses,
        },
        credential: saved.server.credential,
        certificateAuthority: saved.server.certificateAuthority,
        controlDatabaseUrl: input.controlDatabaseUrl,
        signal: input.signal,
        run: async (database) => {
          lock.assertHeld();
          input.signal.throwIfAborted();
          return await inspectProductionProjectPhase(
            database,
            { appClusterId: saved.server.clusterId, controlClusterId },
            claim.resourceId,
            saved.credentials,
            saved.phase,
          );
        },
      });
    } catch {
      outcome = input.signal.aborted ? "interrupted" : "review";
    }
    lock.assertHeld();
    return await finishProductionProvisionReview(
      input.database,
      claim,
      outcome,
    );
  } finally {
    await lock.release();
  }
}
