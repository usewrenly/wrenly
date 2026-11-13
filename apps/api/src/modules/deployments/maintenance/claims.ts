/** Durable restart ownership; no expired attempt is automatically reclaimed or replayed. */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  type db,
  user,
  projects,
  productionRuntimeMaintenance,
  productionRuntimeMaintenanceAttempts,
} from "@wrenly/db";
import { ProductionMaintenanceGrant } from "@wrenly/db/production-maintenance-contract";
import {
  MaintenanceAttempt,
  beginMaintenanceEffect,
  acknowledgeMaintenanceEffect,
  expireMaintenanceAttempt,
} from "@wrenly/db/production-maintenance-attempt";
import { lockDatabaseQueues } from "../../databases/database-store";
import { DeploymentStoreError } from "../persistence/deployment-store";
import { verifyMaintenancePublication } from "./store";
const LEASE_MS = 30000;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface MaintenanceClaim {
  id: string;
  deploymentId: string;
  projectId: string;
  token: string;
  grantRevision: string;
}
/** Caller owns global queue locks before account/project locks; no session is invented for a background worker. */
async function authority(
  tx: Transaction,
  deploymentId: string,
  revision: string,
): Promise<ProductionMaintenanceGrant> {
  const [row] = await tx
    .select()
    .from(productionRuntimeMaintenance)
    .where(eq(productionRuntimeMaintenance.deploymentId, deploymentId));
  const grant = ProductionMaintenanceGrant.parse(row?.grant);
  const [owner] = await tx
    .select()
    .from(user)
    .where(eq(user.id, grant.confirmedBy.userId))
    .for("share");
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, grant.binding.projectId))
    .for("share");
  if (
    !owner ||
    owner.banned ||
    owner.accessRevision !== grant.confirmedBy.revision ||
    !project ||
    project.userId !== owner.id ||
    project.archivedAt ||
    project.accessRevision !== grant.binding.principal.accessRevision ||
    grant.state !== "enabled" ||
    grant.revision !== revision ||
    grant.binding.deploymentId !== deploymentId ||
    row?.projectId !== project.id
  )
    throw new DeploymentStoreError(
      409,
      "Maintenance permission changed or is inactive.",
    );
  await verifyMaintenancePublication(tx, grant);
  return grant;
}
/** Explicit scheduler admission refuses every unfinished attempt, including expired claims with unknown effects. */
export async function claimMaintenance(
  database: typeof db,
  deploymentId: string,
  revision: string,
): Promise<MaintenanceClaim> {
  z.uuid().parse(deploymentId);
  z.uuid().parse(revision);
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const grant = await authority(tx, deploymentId, revision);
    const previous = await tx
      .select()
      .from(productionRuntimeMaintenanceAttempts)
      .where(
        eq(
          productionRuntimeMaintenanceAttempts.projectId,
          grant.binding.projectId,
        ),
      )
      .for("update");
    if (
      previous.some(
        (row) => MaintenanceAttempt.parse(row.journal).status !== "success",
      )
    )
      throw new DeploymentStoreError(
        409,
        "Inspect the unfinished maintenance attempt before starting another.",
      );
    const now = new Date(),
      id = crypto.randomUUID(),
      token = crypto.randomUUID();
    const journal = MaintenanceAttempt.parse({
      id,
      grantRevision: revision,
      claimToken: token,
      leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
      status: "running",
      pending: null,
      completed: [],
    });
    await tx
      .insert(productionRuntimeMaintenanceAttempts)
      .values({
        id,
        deploymentId,
        projectId: grant.binding.projectId,
        journal,
      });
    return {
      id,
      deploymentId,
      projectId: grant.binding.projectId,
      token,
      grantRevision: revision,
    };
  });
}
async function held(
  tx: Transaction,
  claim: MaintenanceClaim,
): Promise<MaintenanceAttempt> {
  const grant = await authority(tx, claim.deploymentId, claim.grantRevision);
  const [row] = await tx
    .select()
    .from(productionRuntimeMaintenanceAttempts)
    .where(eq(productionRuntimeMaintenanceAttempts.id, claim.id))
    .for("update");
  const journal = MaintenanceAttempt.parse(row?.journal);
  if (
    row?.deploymentId !== claim.deploymentId ||
    row.projectId !== claim.projectId ||
    grant.binding.projectId !== claim.projectId ||
    journal.id !== claim.id ||
    journal.claimToken !== claim.token ||
    journal.grantRevision !== claim.grantRevision ||
    journal.status !== "running" ||
    Date.parse(journal.leaseExpiresAt) <= Date.now()
  )
    throw new DeploymentStoreError(
      409,
      "Maintenance claim changed or expired.",
    );
  return journal;
}
/** Save intent or its independently verified acknowledgement while the same current grant and lease remain valid. */
export async function advanceMaintenance(
  database: typeof db,
  claim: MaintenanceClaim,
  acknowledgementId?: string,
): Promise<MaintenanceAttempt> {
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const journal = await held(tx, claim),
      now = new Date();
    const next =
      acknowledgementId === undefined
        ? beginMaintenanceEffect(journal, claim.token, claim.grantRevision, now)
        : acknowledgeMaintenanceEffect(
            journal,
            claim.token,
            claim.grantRevision,
            acknowledgementId,
            now,
          );
    await tx
      .update(productionRuntimeMaintenanceAttempts)
      .set({ journal: next, updatedAt: now })
      .where(eq(productionRuntimeMaintenanceAttempts.id, claim.id));
    return next;
  });
}
/** Only a still-current live claim can renew. An expired claim remains a recovery task. */
export async function renewMaintenance(
  database: typeof db,
  claim: MaintenanceClaim,
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const journal = await held(tx, claim),
      now = new Date();
    await tx
      .update(productionRuntimeMaintenanceAttempts)
      .set({
        journal: {
          ...journal,
          leaseExpiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
        },
        updatedAt: now,
      })
      .where(eq(productionRuntimeMaintenanceAttempts.id, claim.id));
  });
}
/** Expiry recording needs no active owner grant: revoked work must still retain its unresolved intent. */
export async function recordMaintenanceExpiry(
  database: typeof db,
  claim: MaintenanceClaim,
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    const [row] = await tx
      .select()
      .from(productionRuntimeMaintenanceAttempts)
      .where(
        and(
          eq(productionRuntimeMaintenanceAttempts.id, claim.id),
          eq(
            productionRuntimeMaintenanceAttempts.deploymentId,
            claim.deploymentId,
          ),
        ),
      )
      .for("update");
    const journal = MaintenanceAttempt.parse(row?.journal);
    if (
      journal.claimToken !== claim.token ||
      row?.projectId !== claim.projectId
    )
      throw new DeploymentStoreError(409, "Maintenance claim changed.");
    const now = new Date();
    await tx
      .update(productionRuntimeMaintenanceAttempts)
      .set({ journal: expireMaintenanceAttempt(journal, now), updatedAt: now })
      .where(eq(productionRuntimeMaintenanceAttempts.id, claim.id));
  });
}
