/** Continue completed SQL creation into the resource journal; this never performs provisioning SQL or marks readiness. */
import { and, asc, eq, isNull } from "drizzle-orm";
import { productionDatabaseProvisions, type db } from "@wrenly/db";
import { acquireDatabaseExecutorLock } from "../../database-executor-lock";
import {
  attachProductionProjectResource,
  type ProductionResourceReceipt,
} from "./resource-store";
/** Restart recovery uses only the original saved execution identity; an expired session cannot be replaced silently. */
export async function attachCompletedProductionProvision(input: {
  database: typeof db;
  directory: string;
  signal: AbortSignal;
}): Promise<ProductionResourceReceipt | null> {
  input.signal.throwIfAborted();
  const [saved] = await input.database
    .select()
    .from(productionDatabaseProvisions)
    .where(
      and(
        eq(productionDatabaseProvisions.mode, "cluster"),
        eq(productionDatabaseProvisions.status, "created"),
        isNull(productionDatabaseProvisions.effectPhase),
        isNull(productionDatabaseProvisions.effectStartedAt),
      ),
    )
    .orderBy(asc(productionDatabaseProvisions.createdAt))
    .limit(1);
  if (!saved) return null;
  const lock = await acquireDatabaseExecutorLock({
    id: saved.id,
    resourceId: saved.id,
    projectId: saved.projectId,
    token: crypto.randomUUID(),
  });
  try {
    lock.assertHeld();
    input.signal.throwIfAborted();
    // Attachment publishes the readiness claim; do not leave its kernel lock held
    // while another worker can claim it. The transaction still proves completed SQL.
    await lock.release();
    return await attachProductionProjectResource({
      database: input.database,
      directory: input.directory,
      projectId: saved.projectId,
      provisionId: saved.id,
      principal: saved.executionPrincipal ?? {
        userId: saved.actorId,
        sessionId: saved.sessionId,
        revision: saved.accountRevision,
      },
    });
  } catch {
    throw new Error(
      "Completed Production creation could not be attached. Its SQL and saved ownership are preserved for review.",
    );
  } finally {
    await lock.release();
  }
}
