/**
 * Operator reconciliation persistence.
 * Reads settled interrupted operations and atomically verifies the inspected state before releasing its reservation.
 * Never exposes snapshots over HTTP or repeats remote mutations.
 */

import { logger } from "../../../lib/logger";
import type { db } from "@wrenly/db";
import { eq } from "drizzle-orm";
import {
  deployments,
  deploymentResources,
} from "../../../../../../packages/db/src/schema";
import { DeploymentStoreError } from "./deployment-store";

/** Server/operator-only snapshot. Never mount this data as an HTTP response. */
export async function loadInterruptedDeployment(
  database: typeof db,
  id: string,
): Promise<{
  deployment: typeof deployments.$inferSelect;
  resources: typeof deploymentResources.$inferSelect;
}> {
  try {
    const [deployment] = await database
      .select()
      .from(deployments)
      .where(eq(deployments.id, id));
    if (
      !deployment ||
      deployment.status !== "interrupted" ||
      deployment.claimToken ||
      Date.now() - deployment.updatedAt.getTime() < 65_000
    )
      throw new DeploymentStoreError(
        409,
        "Reconciliation requires an interrupted operation settled for at least 65 seconds.",
      );
    const [resources] = await database
      .select()
      .from(deploymentResources)
      .where(eq(deploymentResources.projectId, deployment.projectId));
    if (!resources) throw new Error("Deployment resources are missing.");
    return { deployment, resources };
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    logger.error("Publishing reconciliation persistence failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new Error(
      "Publishing reconciliation persistence could not be verified.",
      { cause: error },
    );
  }
}

/** Completes a verified operator reconciliation without replaying any remote mutation. */
export async function finishInterruptedReconciliation(
  database: typeof db,
  original: Awaited<ReturnType<typeof loadInterruptedDeployment>>,
  verified: {
    repositoryId: string | null;
    applicationId: string | null;
    jobId: string | null;
  },
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(deployments)
        .where(eq(deployments.id, original.deployment.id))
        .for("update");
      const [resources] = await transaction
        .select()
        .from(deploymentResources)
        .where(eq(deploymentResources.projectId, original.deployment.projectId))
        .for("update");
      if (
        !current ||
        !resources ||
        current.status !== "interrupted" ||
        current.claimToken ||
        current.updatedAt.getTime() !==
          original.deployment.updatedAt.getTime() ||
        JSON.stringify(current.mutationIntent) !==
          JSON.stringify(original.deployment.mutationIntent) ||
        resources.updatedAt.getTime() !== original.resources.updatedAt.getTime()
      )
        throw new DeploymentStoreError(
          409,
          "Deployment changed during reconciliation.",
        );
      await transaction
        .update(deploymentResources)
        .set({
          repositoryId: verified.repositoryId,
          coolifyApplicationUuid: verified.applicationId,
          updatedAt: new Date(),
        })
        .where(eq(deploymentResources.projectId, current.projectId));
      await transaction
        .update(deployments)
        .set({
          status: "failed",
          mutationIntent: null,
          remoteDeploymentUuid: verified.jobId,
          errorCode: "EXECUTION_INTERRUPTED",
          updatedAt: new Date(),
          completedAt: new Date(),
        })
        .where(eq(deployments.id, current.id));
    });
  } catch (error) {
    if (error instanceof DeploymentStoreError) throw error;
    logger.error("Publishing reconciliation persistence failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new Error(
      "Publishing reconciliation persistence could not be verified.",
      { cause: error },
    );
  }
}
