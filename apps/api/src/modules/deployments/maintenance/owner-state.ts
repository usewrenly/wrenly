/** Owner-only projections and receipt lookup perform no remote operation and reveal no execution binding. */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type db,
  deployments,
  productionRuntimeMaintenance,
  productionRuntimeMaintenanceActions,
  productionRuntimeMaintenanceAttempts,
} from "@wrenly/db";
import {
  ProductionMaintenanceGrant,
  MaintenanceView,
  MaintenanceDecisionReceipt,
} from "@wrenly/db/production-maintenance-contract";
import { MaintenanceAttempt } from "@wrenly/db/production-maintenance-attempt";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { lockMaintenanceOwner } from "./store";
import { DeploymentStoreError } from "../persistence/deployment-store";
/** Receipt reads preserve the original result even if a newer owner decision changed permission. */
export async function readMaintenanceOwnerState(input: {
  database: typeof db;
  actor: AccessPrincipal;
  projectId: string;
  deploymentId: string;
  requestId?: string;
}): Promise<MaintenanceView | MaintenanceDecisionReceipt | null> {
  z.uuid().parse(input.projectId);
  z.uuid().parse(input.deploymentId);
  if (input.requestId) z.uuid().parse(input.requestId);
  return input.database.transaction(async (tx) => {
    const project = await lockMaintenanceOwner(
      tx,
      input.projectId,
      input.actor,
    );
    const [publication] = await tx
      .select({
        projectId: deployments.projectId,
        binding: deployments.productionDatabaseBinding,
      })
      .from(deployments)
      .where(eq(deployments.id, input.deploymentId));
    if (publication?.projectId !== project.id || !publication.binding)
      throw new DeploymentStoreError(
        404,
        "Database-backed publication not found.",
      );
    if (input.requestId) {
      const [action] = await tx
        .select()
        .from(productionRuntimeMaintenanceActions)
        .where(
          and(
            eq(productionRuntimeMaintenanceActions.actorId, input.actor.userId),
            eq(productionRuntimeMaintenanceActions.projectId, project.id),
            eq(
              productionRuntimeMaintenanceActions.deploymentId,
              input.deploymentId,
            ),
            eq(productionRuntimeMaintenanceActions.requestId, input.requestId),
          ),
        );
      if (!action) return null;
      const grant = ProductionMaintenanceGrant.parse(action.result);
      return MaintenanceDecisionReceipt.parse({
        requestId: action.requestId,
        grantRevision: grant.revision,
        state: grant.state,
        replayed: true,
      });
    }
    const [saved] = await tx
      .select()
      .from(productionRuntimeMaintenance)
      .where(eq(productionRuntimeMaintenance.deploymentId, input.deploymentId));
    const [latest] = await tx
      .select()
      .from(productionRuntimeMaintenanceAttempts)
      .where(
        eq(
          productionRuntimeMaintenanceAttempts.deploymentId,
          input.deploymentId,
        ),
      )
      .orderBy(
        desc(productionRuntimeMaintenanceAttempts.createdAt),
        desc(productionRuntimeMaintenanceAttempts.id),
      )
      .limit(1);
    const grant = saved ? ProductionMaintenanceGrant.parse(saved.grant) : null;
    const attempt = latest ? MaintenanceAttempt.parse(latest.journal) : null;
    return MaintenanceView.parse({
      accessRevision: project.accessRevision,
      grantRevision: grant?.revision ?? null,
      state: grant?.state ?? "disabled",
      attempt:
        latest && attempt
          ? {
              status:
                attempt.status === "running" &&
                Date.parse(attempt.leaseExpiresAt) <= Date.now()
                  ? "interrupted"
                  : attempt.status,
              step: attempt.pending?.step ?? null,
              updatedAt: latest.updatedAt.toISOString(),
            }
          : null,
    });
  });
}
