/**
 * COMPONENT: Explicit database preview claim
 * PURPOSE: Recheck a saved reservation before a database-capable runtime may prepare it.
 * INPUTS: Control database; no browser source, actor or connection override.
 * OUTPUTS: One live preview claim with saved code and validated evidence, or no work.
 * STEPS: Lock queues, respect global preparation/cleanup blockers, authorize the saved
 * submitting actor, lock the exact resource, compare all evidence/source, then claim the row.
 * EDGE CASES: Stale or revoked reservations require review/stop; no fallback to another database.
 * ERROR STATES: No Docker effects occur here; ordinary preview workers never call this factory.
 */
import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import {
  previews,
  previewDatabaseBindings,
  previewDatabaseRuntime,
  type db,
} from "@wrenly/db";
import { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";
import {
  requireProjectCapability,
  unarchivedProjectPredicate,
} from "../../projects/access/project-access";
import {
  PREVIEW_LEASE_MS,
  type PreviewClaim,
} from "../../previews/persistence/preview-store";
import { AppDatabaseError } from "../database-contract";
import { lockDatabaseQueues } from "../database-store";
import { databaseValidationSourceDigest } from "../validation/source-identity";
import { freezePreviewDatabaseBinding } from "./preview-binding";

export interface DatabasePreviewClaim extends PreviewClaim {
  stack: "nextjs" | "laravel";
  files: Array<{ path: string; content: string }>;
  database: ValidatedDatabaseRevision;
}

/** This explicit path is not installed in production; a claim grants no credentials or network access. */
export async function claimNextDatabasePreview(
  database: typeof db,
): Promise<DatabasePreviewClaim | null> {
  try {
    return await database.transaction(async (transaction) => {
      await lockDatabaseQueues(transaction, { wait: true });
      const [busy] = await transaction
        .select({ id: previews.id })
        .from(previews)
        .where(
          and(
            isNull(previews.cleanupCompletedAt),
            notInArray(previews.status, ["queued", "ready"]),
          ),
        )
        .limit(1);
      if (busy) return null;
      const [candidate] = await transaction
        .select({
          preview: previews,
          evidence: previewDatabaseBindings.revision,
          resourceId: previewDatabaseBindings.resourceId,
        })
        .from(previews)
        .innerJoin(
          previewDatabaseBindings,
          eq(previewDatabaseBindings.previewId, previews.id),
        )
        .where(
          and(
            eq(previews.status, "queued"),
            isNull(previews.cleanupCompletedAt),
            unarchivedProjectPredicate(transaction, previews.projectId),
          ),
        )
        .orderBy(asc(previews.createdAt), asc(previews.id))
        .limit(1);
      if (!candidate) return null;
      await requireProjectCapability(
        transaction,
        candidate.preview.projectId,
        candidate.preview.userId,
        "contribute",
      );
      const saved = ValidatedDatabaseRevision.parse(candidate.evidence);
      if (
        saved.binding.projectId !== candidate.preview.projectId ||
        saved.binding.buildId !== candidate.preview.buildId ||
        saved.binding.resourceId !== candidate.resourceId ||
        databaseValidationSourceDigest(candidate.preview.files) !==
          saved.sourceDigest
      )
        throw new AppDatabaseError(
          409,
          "The queued preview no longer matches its saved database evidence.",
        );
      const current = await freezePreviewDatabaseBinding(
        transaction,
        candidate.preview.projectId,
        candidate.preview.buildId,
        candidate.preview.userId,
        {
          version: 1,
          environment: "development",
          resourceId: saved.binding.resourceId,
          resourceRevision: saved.binding.resourceRevision,
        },
      );
      if (JSON.stringify(current) !== JSON.stringify(saved))
        throw new AppDatabaseError(
          409,
          "The queued preview's database or source changed. Review it before preparing again.",
        );
      const [locked] = await transaction
        .select()
        .from(previews)
        .where(eq(previews.id, candidate.preview.id))
        .for("update");
      if (
        !locked ||
        locked.status !== "queued" ||
        locked.cleanupCompletedAt ||
        locked.buildId !== candidate.preview.buildId ||
        locked.userId !== candidate.preview.userId ||
        databaseValidationSourceDigest(locked.files) !== saved.sourceDigest
      )
        throw new AppDatabaseError(
          409,
          "The queued database preview changed before it could be claimed.",
        );
      const token = crypto.randomUUID();
      // Existing journal state requires inspection, never adoption by a replacement executor.
      await transaction
        .insert(previewDatabaseRuntime)
        .values({ previewId: locked.id });
      await transaction
        .update(previews)
        .set({
          status: "preparing",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + PREVIEW_LEASE_MS),
          updatedAt: new Date(),
        })
        .where(eq(previews.id, locked.id));
      return {
        previewId: locked.id,
        projectId: locked.projectId,
        buildId: locked.buildId,
        token,
        stack: saved.binding.framework,
        files: locked.files,
        database: current,
      };
    });
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      409,
      "Database preview ownership could not be confirmed. Review the saved reservation before another attempt.",
    );
  }
}
