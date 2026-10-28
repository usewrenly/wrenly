/** Real metadata/key/lock acceptance with synthetic app/ingress resources; native startup has separate Docker checks. */
import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import { previews, previewDatabaseRuntime } from "../../src/schema";
import { admitDatabasePreview } from "../../../../apps/api/src/modules/previews/persistence/preview-store";
import { claimNextDatabasePreview } from "../../../../apps/api/src/modules/databases/bindings/preview-claim";
import { acquirePreviewExecutorLock } from "../../../../apps/api/src/modules/previews/execution/preview-executor-lock";
import { preparePreviewDatabaseArtifact } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-preparation";
import { openPreviewDatabaseSocket } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-socket";
import { startPreviewDatabaseApplication } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-startup";
import { loadPreviewDatabaseApplicationSettings } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-settings";

/** Repeated preview claims retain one resource-scoped Development key, without persisting it in their journals. */
export async function verifyPreviewStartup(
  database: typeof db, directory: string, buildId: string, resourceId: string, resourceRevision: string,
): Promise<void> {
  let originalAppKey: string | null | undefined;
  const imageId = `sha256:${"e".repeat(64)}`;
  for (const scenario of ["success", "unknown", "missing-started", "foreign-image"] as const) {
    const admitted = await admitDatabasePreview(database, buildId, "db-editor", crypto.randomUUID(), {
      version: 1, environment: "development", resourceId, resourceRevision,
    });
    const claim = await claimNextDatabasePreview(database);
    if (!claim || claim.previewId !== admitted.previewId) throw new Error("Missing startup claim");
    const lock = await acquirePreviewExecutorLock(claim);
    const held = (): void => lock.assertHeld();
    const signal = new AbortController().signal;
    try {
      await preparePreviewDatabaseArtifact(database, claim, signal, held, async (input) => {
        await input.beforeEffect();
        return { imageId, baseImageId: imageId, sizeBytes: 100 };
      });
      await openPreviewDatabaseSocket(database, claim, directory, signal, held, async (input) => {
        const effect = { kind: "create-socket" as const, id: `wrenly-database-socket-${claim.previewId}` };
        await input.fence.beforeEffect(effect);
        await input.fence.acknowledgeEffect(effect);
        return { id: claim.previewId, projectId: claim.projectId, resourceId, containerId: "1".repeat(64),
          volumeName: effect.id, imageId };
      });
      const settings = await loadPreviewDatabaseApplicationSettings(database, claim, directory, held);
      if (originalAppKey === undefined) originalAppKey = settings.appKey;
      expect(settings.appKey).toBe(originalAppKey);
      if (claim.stack === "laravel") expect(settings.appKey).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
      else expect(settings.appKey).toBeNull();
      await expect(loadPreviewDatabaseApplicationSettings(database, claim, `${directory}/missing-key`, held))
        .rejects.toMatchObject({ status: 409 });
      let calls = 0;
      const start: NonNullable<Parameters<typeof startPreviewDatabaseApplication>[5]> = async (input) => {
        calls++;
        await input.assertHeld();
        expect(input.framework).toBe(claim.stack);
        expect(input.role).toEqual(settings.role);
        expect(input.appKey).toBe(settings.appKey);
        expect(input.scope.resourceId).toBe(resourceId);
        expect(input.imageId).toBe(imageId);
        const [pending] = await database.select().from(previewDatabaseRuntime)
          .where(eq(previewDatabaseRuntime.previewId, claim.previewId));
        expect(pending?.effect?.kind).toBe("start-application");
        const resources = { appContainerId: "2".repeat(64), ingressContainerId: "3".repeat(64),
          appNetworkId: "4".repeat(64), ingressNetworkId: "5".repeat(64) };
        const preparation = { imageId, lockfileSha256: null };
        if (scenario !== "missing-started") await input.onStarted(resources, preparation);
        if (scenario === "unknown") throw new Error("PRIVATE_STARTUP_REPLY_LOST");
        return { resources, ingressUrl: "http://127.0.0.1:1234",
          imageId: scenario === "foreign-image" ? `sha256:${"f".repeat(64)}` : imageId,
          lockfileSha256: null, output: "" };
      };
      const run = (): ReturnType<typeof startPreviewDatabaseApplication> => startPreviewDatabaseApplication(
        database, claim, { directory, lifetimeMs: 30_000, ingressBundle: new Uint8Array([1]),
          ingress: { previewOrigin: "http://preview.localhost:3003", controlOrigin: "http://localhost:3000",
            capability: "b".repeat(64), blockedCookieNames: [] } }, signal, held, start,
        async () => new Uint8Array([1]),
      );
      if (scenario === "success") expect((await run()).imageId).toBe(imageId);
      else await expect(run()).rejects.toMatchObject({ status: 409 });
      await expect(run()).rejects.toMatchObject({ status: 409 });
      expect(calls).toBe(1);
      const [runtime] = await database.select().from(previewDatabaseRuntime)
        .where(eq(previewDatabaseRuntime.previewId, claim.previewId));
      const [preview] = await database.select().from(previews).where(eq(previews.id, claim.previewId));
      expect(runtime?.effect?.kind ?? null).toBe(scenario === "success" ? null : "start-application");
      expect(preview?.status).toBe(scenario === "success" ? "starting" : "interrupted");
      expect(preview?.cleanupCompletedAt).toBeNull();
      expect(JSON.stringify(runtime)).not.toContain(settings.role.password);
      if (settings.appKey) expect(JSON.stringify(runtime)).not.toContain(settings.appKey);
    } finally {
      await lock.release();
      await database.delete(previews).where(eq(previews.id, claim.previewId));
    }
  }
}
