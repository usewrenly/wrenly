/** Exact-source preparation uses real control storage and kernel locks with a synthetic image builder. */
import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import { previews, previewDatabaseRuntime } from "../../src/schema";
import { preparePreviewDatabaseArtifact } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-preparation";
import { admitDatabasePreview } from "../../../../apps/api/src/modules/previews/persistence/preview-store";
import { claimNextDatabasePreview } from "../../../../apps/api/src/modules/databases/bindings/preview-claim";
import { acquirePreviewExecutorLock } from "../../../../apps/api/src/modules/previews/execution/preview-executor-lock";

/** No Docker work occurs; failures must preserve the target without authorizing a second preparation. */
export async function verifyPreviewPreparation(
  database: typeof db,
  projectId: string,
  buildId: string,
  resourceId: string,
  resourceRevision: string,
): Promise<void> {
  for (const scenario of ["success", "unknown", "changed-source", "cancelled"] as const) {
    const admitted = await admitDatabasePreview(database, buildId, "db-editor", crypto.randomUUID(), {
      version: 1, environment: "development", resourceId, resourceRevision,
    });
    const claim = await claimNextDatabasePreview(database);
    if (!claim || claim.previewId !== admitted.previewId) throw new Error("Missing preparation fixture claim");
    const lock = await acquirePreviewExecutorLock(claim);
    const held = (): void => lock.assertHeld();
    const controller = new AbortController();
    let calls = 0;
    const imageId = `sha256:${"e".repeat(64)}`;
    const prepare: NonNullable<Parameters<typeof preparePreviewDatabaseArtifact>[4]> = async (input) => {
      calls++;
      expect(Object.keys(input).sort()).toEqual([
        "beforeEffect", "deploymentId", "files", "migrationDigest", "signal", "stack",
      ]);
      expect(input.deploymentId).toBe(claim.previewId);
      expect(input.stack).toBe(claim.stack);
      expect(input.files).toEqual(claim.files);
      expect(input.migrationDigest).toBe(claim.database.binding.migrationDigest);
      const [pending] = await database.select().from(previewDatabaseRuntime)
        .where(eq(previewDatabaseRuntime.previewId, claim.previewId));
      expect(pending?.effect?.kind).toBe("prepare-artifact");
      await input.beforeEffect();
      if (scenario === "unknown") throw new Error("PRIVATE_IMAGE_RESPONSE_LOST");
      if (scenario === "changed-source") {
        await database.update(previews).set({ files: [...claim.files, { path: "changed.txt", content: "changed" }] })
          .where(eq(previews.id, claim.previewId));
        await expect(input.beforeEffect()).rejects.toThrow();
      }
      return { imageId, baseImageId: `sha256:${"f".repeat(64)}`, sizeBytes: 100 };
    };
    try {
      if (scenario === "cancelled") controller.abort();
      const run = (): Promise<{ imageId: string }> =>
        preparePreviewDatabaseArtifact(database, claim, controller.signal, held, prepare);
      if (scenario === "success") {
        expect(await run()).toEqual({ imageId });
        await expect(run()).rejects.toMatchObject({ status: 409 });
      } else await expect(run()).rejects.toMatchObject({ status: 409 });
      expect(calls).toBe(scenario === "cancelled" ? 0 : 1);
      const [runtime] = await database.select().from(previewDatabaseRuntime)
        .where(eq(previewDatabaseRuntime.previewId, claim.previewId));
      const [preview] = await database.select().from(previews).where(eq(previews.id, claim.previewId));
      expect(runtime?.imageId).toBe(scenario === "success" ? imageId : null);
      expect(runtime?.effect?.kind ?? null).toBe(
        scenario === "unknown" || scenario === "changed-source" ? "prepare-artifact" : null,
      );
      expect(preview?.status).toBe(scenario === "unknown" || scenario === "changed-source" ? "interrupted" : "preparing");
      expect(preview?.cleanupCompletedAt).toBeNull();
      expect(runtime?.socket).toBeNull();
      if (scenario !== "success") {
        await expect(run()).rejects.toMatchObject({ status: 409 });
        expect(calls).toBe(scenario === "cancelled" ? 0 : 1);
      }
    } finally {
      await lock.release();
      await database.delete(previews).where(eq(previews.id, claim.previewId));
    }
  }
}
