/** Rechecks database-backed runtime evidence before the gateway forwards any application traffic. */
import { eq } from "drizzle-orm";
import { builds, previews, previewDatabaseRuntime, type db } from "@wrenly/db";
import { readAppDatabaseManifest } from "@wrenly/sandbox";
import { AppDatabaseSocketIdentity } from "@wrenly/db/app-database-runtime-contract";
import { assertPreviewDatabaseBinding } from "./preview-binding";
import { databaseValidationSourceDigest } from "../validation/source-identity";
import { RUNTIME_EFFECT_ORDER, previewRuntimeEffectTarget } from "../preview-runtime/runtime-policy";

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Existing viewer/session authorization remains mandatory; this check supplies no credentials or new access. */
export async function databasePreviewIsReady(
  database: Database,
  preview: typeof previews.$inferSelect,
): Promise<boolean> {
  try {
    const [build] = await database.select({ stack: builds.stack, files: builds.files }).from(builds)
      .where(eq(builds.id, preview.buildId));
    if (!build || !Array.isArray(build.files)) return false;
    // Removing a declaration from a preview must not turn its saved database build into a stateless app.
    const declaresDatabase = (files: unknown[]): boolean => files.some((file) =>
      typeof file === "object" && file !== null && "path" in file && file.path === "wrenly.app.json");
    if (!declaresDatabase(preview.files) && !declaresDatabase(build.files)) return true;
    if (preview.status !== "ready" || !preview.claimToken || preview.cleanupCompletedAt ||
        !preview.expiresAt || preview.expiresAt.getTime() <= Date.now()) return false;
    if ((build.stack !== "nextjs" && build.stack !== "laravel") ||
        !readAppDatabaseManifest(preview.files, build.stack)) return false;
    const claim = {
      previewId: preview.id, projectId: preview.projectId,
      buildId: preview.buildId, token: preview.claimToken, stack: build.stack,
    };
    const evidence = await assertPreviewDatabaseBinding(database, claim);
    if (databaseValidationSourceDigest(preview.files) !== evidence.sourceDigest) return false;
    const [runtime] = await database.select().from(previewDatabaseRuntime)
      .where(eq(previewDatabaseRuntime.previewId, preview.id));
    if (!runtime || runtime.effect || runtime.cleanupEffect || runtime.cleanupToken || runtime.cleanupDeadlineAt ||
        runtime.completedCleanupEffects.length || !runtime.imageId ||
        preview.resources?.preparation?.imageId !== runtime.imageId ||
        runtime.completedEffects.length !== RUNTIME_EFFECT_ORDER.length ||
        runtime.completedEffects.some((effect, index) => {
          const kind = RUNTIME_EFFECT_ORDER[index];
          return !kind || effect.kind !== kind || effect.id !== previewRuntimeEffectTarget(claim, kind);
        })) return false;
    const socket = AppDatabaseSocketIdentity.parse(runtime.socket);
    return socket.id === preview.id && socket.projectId === preview.projectId &&
      socket.resourceId === evidence.binding.resourceId &&
      socket.volumeName === previewRuntimeEffectTarget(claim, "create-socket");
  } catch {
    // Missing/changed evidence is a denial, never a reason to use stateless authorization instead.
    return false;
  }
}
