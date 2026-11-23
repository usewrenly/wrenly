import { readProjectCapabilities } from "../../../projects/access/project-access";
/** Owner-reviewed cleanup and native-history inspection; no interrupted SQL or backup capture is ever repeated. */
import { and, eq, isNull } from "drizzle-orm";
import {
  appDatabases,
  appDatabaseOperations,
  appDatabaseMigrations,
  appDatabaseBackups,
  type db,
} from "@wrenly/db";
import { cleanupProductionOperationClients } from "@wrenly/sandbox/database-operation-cleanup";
import { cleanupDatabaseValidationResources } from "@wrenly/sandbox/database-validation-cleanup";
import { parseProductionResourceBinding } from "@wrenly/db/production-resource-binding";
import {
  executeDatabaseCleanupRecovery,
  type RecoveryResult,
} from "../../viewing/view-recovery";
import {
  acknowledgeDatabaseCleanupEffect,
  heldClaim,
} from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import {
  cleanupProductionResourceOutcome,
  type ProductionRecoveryTarget,
} from "./recovery";
import { isRecoverableProductionOperation } from "./operation-recovery-policy";
import { DatabaseRecovery } from "@wrenly/db/app-database-action-contract";
/** Provider adapters are injectable for isolated acceptance; browser input cannot supply a target or a schema digest. */
export async function recoverProductionOperation(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
  production: ProductionRecoveryTarget,
  adapters = {
    clients: cleanupProductionOperationClients,
    disposable: cleanupDatabaseValidationResources,
    inspect: cleanupProductionResourceOutcome,
  },
): Promise<RecoveryResult> {
  if (!(await readProjectCapabilities(database, projectId, actorId))?.manage)
    throw new AppDatabaseError(404, "Project not found.");
  const request = DatabaseRecovery.parse(body);
  const [receipt] = await database
    .select()
    .from(appDatabaseOperations)
    .where(
      and(
        eq(appDatabaseOperations.actorId, actorId),
        eq(appDatabaseOperations.requestId, request.requestId),
      ),
    );
  const [selected] = await database
    .select()
    .from(appDatabaseOperations)
    .where(
      and(
        eq(appDatabaseOperations.id, request.operationId),
        eq(appDatabaseOperations.projectId, projectId),
      ),
    );
  const originalId =
    selected?.kind === "recover-production-operation" &&
    selected.effect?.kind === "inspect-production-operation"
      ? selected.effect.id
      : request.operationId;
  const [original] = await database
    .select()
    .from(appDatabaseOperations)
    .where(
      and(
        eq(appDatabaseOperations.id, originalId),
        eq(appDatabaseOperations.projectId, projectId),
      ),
    );
  if (
    !original ||
    !isRecoverableProductionOperation(
      receipt?.kind === "recover-production-operation" &&
        receipt.projectId === projectId
        ? { ...original, status: "interrupted" }
        : original,
    )
  )
    throw new AppDatabaseError(
      409,
      "This operation needs its original saved evidence before recovery.",
    );
  const [review] = await database
    .select()
    .from(appDatabaseMigrations)
    .where(eq(appDatabaseMigrations.operationId, original.id));
  const frozenReview = JSON.stringify(review ?? null);
  let frozenBackup: string | null = null;
  if (original.kind === "migrate") {
    const [backup] = review?.backupId
      ? await database
          .select()
          .from(appDatabaseBackups)
          .where(eq(appDatabaseBackups.id, review.backupId))
      : [];
    frozenBackup = JSON.stringify(backup ?? null);
    if (
      !review ||
      review.databaseId !== original.databaseId ||
      review.buildId !== original.buildId ||
      review.digest !== original.migrationDigest ||
      !review.beforeSchemaDigest ||
      !review.rehearsedSchemaDigest ||
      !backup?.verifiedAt ||
      backup.databaseId !== original.databaseId ||
      backup.schemaDigest !== review.beforeSchemaDigest
    )
      throw new AppDatabaseError(
        409,
        "A verified backup and completed frozen rehearsal are required to inspect a persistent migration.",
      );
  }
  let actualDigest: string | null = null;
  const originalEvidence = JSON.stringify(original);
  return executeDatabaseCleanupRecovery(
    database,
    projectId,
    actorId,
    { ...request, operationId: original.id },
    production,
    {
      kind: "recover-production-operation",
      intent: "inspect-production-operation",
      validate: (operation) => {
        if (
          !isRecoverableProductionOperation(operation) ||
          JSON.stringify(operation) !== originalEvidence
        )
          throw new AppDatabaseError(
            409,
            "The interrupted operation changed during recovery.",
          );
      },
      cleanup: async ({ claim, assertHeld }) => {
        await assertHeld();
        const [resource] = await database
          .select()
          .from(appDatabases)
          .where(
            and(
              eq(appDatabases.id, claim.resourceId),
              eq(appDatabases.projectId, projectId),
            ),
          );
        if (
          !resource ||
          resource.environment !== "production" ||
          resource.provider !== "postgres-cluster" ||
          resource.revision !== request.expectedRevision
        )
          throw new AppDatabaseError(
            409,
            "Original Production resource changed.",
          );
        parseProductionResourceBinding(resource.id, resource.providerIdentity);
        const saved = await database
          .update(appDatabaseOperations)
          .set({
            cleanupEffect: {
              kind: "cleanup-production-operation",
              id: original.id,
              startedAt: new Date().toISOString(),
            },
          })
          .where(
            and(heldClaim(claim), isNull(appDatabaseOperations.cleanupEffect)),
          )
          .returning({ id: appDatabaseOperations.id });
        if (saved.length !== 1)
          throw new AppDatabaseError(
            409,
            "Recovery cleanup intent was not saved.",
          );
        await adapters.clients({
          projectId,
          resourceId: claim.resourceId,
          operationId: original.id,
          assertHeld,
        });
        // The restore is always local and operation-owned, even when the source database is Production.
        await adapters.disposable(
          { projectId, resourceId: original.id, environment: "development" },
          original.id,
          claim.resourceId,
          {
            assertHeld,
            beforeCleanup: async () => {
              await assertHeld();
            },
            acknowledgeCleanup: async () => {
              await assertHeld();
            },
          },
        );
        await assertHeld();
        const expected =
          original.kind === "migrate"
            ? [review!.rehearsedSchemaDigest!]
            : [resource.schemaDigest!];
        const outcome = await adapters.inspect(
          database,
          projectId,
          actorId,
          resource.id,
          resource.revision,
          production,
          expected,
          assertHeld,
        );
        if (
          outcome.state !== "ready" ||
          !outcome.schemaDigest ||
          !expected.includes(outcome.schemaDigest)
        )
          throw new AppDatabaseError(
            409,
            "The original database outcome is not verified. Preserve its recovery evidence.",
          );
        actualDigest = outcome.schemaDigest;
        await assertHeld();
        await acknowledgeDatabaseCleanupEffect(database, claim, original.id);
      },
      inspect: async ({ resource, assertHeld }) => {
        await assertHeld();
        if (
          resource.environment !== "production" ||
          resource.provider !== "postgres-cluster" ||
          !actualDigest
        )
          throw new AppDatabaseError(
            409,
            "Production outcome proof is missing.",
          );
      },
      finish: async (tx, operation) => {
        if (!actualDigest)
          throw new AppDatabaseError(
            409,
            "Verified native history is missing.",
          );
        const [currentReview] = await tx
          .select()
          .from(appDatabaseMigrations)
          .where(eq(appDatabaseMigrations.operationId, original.id));
        if (JSON.stringify(currentReview ?? null) !== frozenReview)
          throw new AppDatabaseError(409, "Frozen migration review changed.");
        if (operation.kind === "migrate") {
          const [currentBackup] = currentReview?.backupId
            ? await tx
                .select()
                .from(appDatabaseBackups)
                .where(eq(appDatabaseBackups.id, currentReview.backupId))
            : [];
          if (JSON.stringify(currentBackup ?? null) !== frozenBackup)
            throw new AppDatabaseError(
              409,
              "Verified backup evidence changed.",
            );
          if (actualDigest !== currentReview?.rehearsedSchemaDigest)
            throw new AppDatabaseError(
              409,
              "Applied migration is not independently verified.",
            );
          await tx
            .update(appDatabaseMigrations)
            .set({ completedAt: currentReview.completedAt ?? new Date() })
            .where(eq(appDatabaseMigrations.operationId, original.id));
          await tx
            .update(appDatabases)
            .set({ schemaDigest: actualDigest })
            .where(
              and(
                eq(appDatabases.id, operation.databaseId),
                eq(appDatabases.revision, request.expectedRevision),
              ),
            );
          // The original uncertain effect remains in history. Native schema AND journal proof, not helper cleanup, establishes this outcome.
          await tx
            .update(appDatabaseOperations)
            .set({
              status: "success",
              errorCode: "RECOVERED_VERIFIED_MIGRATION",
            })
            .where(eq(appDatabaseOperations.id, operation.id));
        }
      },
    },
  );
}
