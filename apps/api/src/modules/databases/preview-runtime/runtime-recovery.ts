/** Revokes stale database previews only after the caller proves the original executor quiescent. */
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { previews, previewAccess, previewDatabaseBindings, previewDatabaseRuntime, appDatabases, projects, user, type db } from "@wrenly/db";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { lockDatabaseQueues } from "../database-store";
import { AppDatabaseError } from "../database-contract";
import type { RuntimeKernelFence } from "./runtime-store";

const LIVE = ["preparing", "starting", "ready"] as const;
const TERMINAL = ["stopped", "expired", "failed", "interrupted"] as const;

/** No locks are held while the scheduler stops a task or waits for its dead executor's kernel lock. */
export async function findDatabasePreviewRecovery(database: typeof db): Promise<PreviewClaim | null> {
  try {
    const now = new Date();
    const [saved] = await database.select({ preview: previews }).from(previews)
      .innerJoin(previewDatabaseBindings, eq(previewDatabaseBindings.previewId, previews.id))
      .where(and(isNull(previews.cleanupCompletedAt), or(
        inArray(previews.status, [...TERMINAL]),
        and(inArray(previews.status, [...LIVE]), lte(previews.leaseExpiresAt, now)),
        and(eq(previews.status, "ready"), lte(previews.expiresAt, now)),
      )))
      .orderBy(asc(previews.createdAt)).limit(1);
    if (!saved) return null;
    if (!saved.preview.claimToken) throw new Error("Database preview has no original claim");
    return { previewId: saved.preview.id, projectId: saved.preview.projectId,
      buildId: saved.preview.buildId, token: saved.preview.claimToken };
  } catch {
    throw new AppDatabaseError(409, "Database preview recovery could not verify its saved owner.");
  }
}

/** This does not prove quiescence itself. The caller must already hold the original executor's kernel lock. */
export async function revokeDatabasePreviewForCleanup(
  database: typeof db, claim: PreviewClaim, assertKernel: RuntimeKernelFence,
): Promise<boolean> {
  try {
    return await database.transaction(async (tx) => {
      await assertKernel();
      await lockDatabaseQueues(tx, { wait: true });
      const [snapshot] = await tx.select({ preview: previews, resourceId: previewDatabaseBindings.resourceId })
        .from(previews).innerJoin(previewDatabaseBindings, eq(previewDatabaseBindings.previewId, previews.id))
        .where(and(eq(previews.id, claim.previewId), eq(previews.projectId, claim.projectId),
          eq(previews.buildId, claim.buildId), eq(previews.claimToken, claim.token)));
      if (!snapshot) throw new Error("Recovery owner changed");
      await tx.select({ id: user.id }).from(user).where(eq(user.id, snapshot.preview.userId)).for("update");
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, claim.projectId)).for("update");
      await tx.select({ id: appDatabases.id }).from(appDatabases).where(eq(appDatabases.id, snapshot.resourceId)).for("update");
      const [preview] = await tx.select().from(previews).where(eq(previews.id, claim.previewId)).for("update");
      if (!preview || preview.claimToken !== claim.token) throw new Error("Recovery claim changed");
      if (preview.cleanupCompletedAt) return false;
      const [runtime] = await tx.select().from(previewDatabaseRuntime)
        .where(eq(previewDatabaseRuntime.previewId, claim.previewId)).for("update");
      if (!runtime || runtime.cleanupToken || runtime.cleanupDeadlineAt || runtime.cleanupEffect ||
          runtime.completedCleanupEffects.length) throw new Error("Existing cleanup requires explicit recovery");
      const now = Date.now();
      const expired = preview.status === "ready" && (!preview.expiresAt || preview.expiresAt.getTime() <= now);
      if (LIVE.some((status) => preview.status === status)) {
        if (!expired && preview.leaseExpiresAt && preview.leaseExpiresAt.getTime() > now)
          throw new Error("Live executor still owns this preview");
        await tx.update(previews).set({ status: expired ? "expired" : "interrupted", leaseExpiresAt: null,
          updatedAt: new Date() }).where(and(eq(previews.id, claim.previewId), eq(previews.claimToken, claim.token)));
      } else if (!TERMINAL.some((status) => preview.status === status)) throw new Error("Preview is not stopped");
      await tx.delete(previewAccess).where(eq(previewAccess.previewId, claim.previewId));
      await assertKernel();
      return true;
    });
  } catch {
    throw new AppDatabaseError(409,
      "Database preview cleanup is blocked. Preserve its reservation until executor and cleanup ownership are explicitly resolved.");
  }
}
