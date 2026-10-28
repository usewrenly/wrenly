/** Runs the real bounded scheduler over disposable PostgreSQL and kernel locks with synthetic Docker effects. */
import { expect } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { db } from "@wrenly/db";
import * as schema from "../../src/schema";
import { createDatabasePreviewWorkerServices, type DatabasePreviewWorkerAdapters } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-worker";
import { runPreviewWorker } from "../../../../apps/api/src/modules/previews/execution/preview-worker";
import { acquirePreviewExecutorLock, type PreviewExecutorLock } from "../../../../apps/api/src/modules/previews/execution/preview-executor-lock";
import { admitDatabasePreview, stopPreview, interruptPreview, getPreviewRecoveryCandidate, reconcilePreview, type PreviewClaim } from "../../../../apps/api/src/modules/previews/persistence/preview-store";
import { beginPreviewDatabaseCleanup } from "../../../../apps/api/src/modules/databases/preview-runtime/cleanup-store";
import { cleanupPreviewDatabaseRuntime } from "../../../../apps/api/src/modules/databases/preview-runtime/runtime-cleanup";

/** Failure reserves capacity; only the explicit fixture recovery resumes an unknown cleanup. */
export async function verifyPreviewWorker(
  database: typeof db, directory: string, projectId: string, buildId: string, resourceId: string, resourceRevision: string,
): Promise<void> {
  for (const scenario of ["stop", "shutdown", "revocation", "unknown-startup", "cleanup-failure", "old-executor"] as const) {
    const admitted = await admitDatabasePreview(database, buildId, "db-editor", crypto.randomUUID(), {
      version: 1, environment: "development", resourceId, resourceRevision,
    });
    const locks = new Map<string, PreviewExecutorLock>();
    const key = (claim: PreviewClaim): string => `${claim.previewId}:${claim.token}`;
    let recovered = 0;
    const execution = {
      acquire: async (claim: PreviewClaim): Promise<void> => {
        if (!locks.has(key(claim))) locks.set(key(claim), await acquirePreviewExecutorLock(claim));
      },
      assertHeld: (claim: PreviewClaim): void => {
        const lock = locks.get(key(claim));
        if (!lock) throw new Error("Fixture lock missing");
        lock.assertHeld();
      },
      release: async (claim: PreviewClaim): Promise<void> => {
        await locks.get(key(claim))?.release(); locks.delete(key(claim));
      },
      assertExternalQuiescent: async (claim: PreviewClaim): Promise<void> => {
        recovered++; await execution.acquire(claim); execution.assertHeld(claim);
      },
    };
    const imageId = `sha256:${"e".repeat(64)}`;
    const effects: string[] = [];
    const removals: string[] = [];
    let failCleanup = scenario === "cleanup-failure";
    const adapters: DatabasePreviewWorkerAdapters = {
      prepare: async (input) => {
        await input.beforeEffect(); effects.push("prepare");
        return { imageId, baseImageId: imageId, sizeBytes: 100 };
      },
      socket: async (input) => {
        const effect = { kind: "create-socket" as const, id: `wrenly-database-socket-${input.socketId}` };
        await input.fence.beforeEffect(effect); effects.push("socket");
        await input.fence.acknowledgeEffect(effect);
        return { id: input.socketId, projectId, resourceId, containerId: "1".repeat(64), imageId, volumeName: effect.id };
      },
      bundle: async () => new Uint8Array([1]),
      start: async (input) => {
        await input.assertHeld(); effects.push("application");
        const resources = { appContainerId: "2".repeat(64), ingressContainerId: "3".repeat(64),
          appNetworkId: "4".repeat(64), ingressNetworkId: "5".repeat(64) };
        await input.onStarted(resources, { imageId, lockfileSha256: null });
        if (scenario === "unknown-startup") throw new Error("PRIVATE_STARTUP_REPLY_LOST");
        return { resources, ingressUrl: "http://127.0.0.1:1234", imageId, lockfileSha256: null, output: "" };
      },
      check: async () => {},
      cleanup: {
        application: async (_identity, held) => {
          await held?.(); removals.push("application");
          if (failCleanup) throw new Error("PRIVATE_CLEANUP_REPLY_LOST");
        },
        socket: async (_scope, _id, held) => { await held?.(); removals.push("socket"); },
        administratorBundle: async () => new Uint8Array([1]),
        sessions: async (input) => { await input.fence.assertHeld(); removals.push("sessions"); },
        artifact: async (_id, held) => { await held(); removals.push("artifact"); },
      },
    };
    const configuration = { directory, lifetimeMs: 30_000, ingressBundle: new Uint8Array([1]),
      ingressFor: () => ({ previewOrigin: "http://preview.localhost:3003", controlOrigin: "http://localhost:3000",
        capability: "b".repeat(64), blockedCookieNames: [] }) };
    let services = createDatabasePreviewWorkerServices(database, configuration, execution, adapters);
    const shutdown = new AbortController();
    let done: Promise<void> | undefined;
    const snapshot = async () => (await database.select().from(schema.previews)
      .where(eq(schema.previews.id, admitted.previewId)))[0];
    const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + 15_000;
      while (!await condition()) {
        if (Date.now() > deadline) {
          const row = await snapshot();
          const [journal] = await database.select().from(schema.previewDatabaseRuntime)
            .where(eq(schema.previewDatabaseRuntime.previewId, admitted.previewId));
          throw new Error(`Worker fixture timed out: ${scenario}; status=${row?.status}; effects=${effects.join(",")}; pending=${journal?.effect?.kind}; cleanup=${journal?.cleanupEffect?.kind}; removals=${removals.join(",")}`);
        }
        await Bun.sleep(25);
      }
    };
    try {
      if (scenario === "old-executor") {
        const claim = await services.dependencies.claim();
        if (!claim) throw new Error("Missing old executor claim");
        await services.dependencies.prepare(claim, shutdown.signal);
        expect(services.runtime(claim.previewId)).toBeNull();
        await interruptPreview(database, claim);
        await execution.release(claim);
        // Ordinary recovery must never acknowledge database cleanup or release its capacity.
        expect(await getPreviewRecoveryCandidate(database)).toBeNull();
        let ordinaryCleanup = 0;
        expect(await reconcilePreview(database, async () => { ordinaryCleanup++; }, claim.previewId)).toBe(false);
        expect(ordinaryCleanup).toBe(0);
        services = createDatabasePreviewWorkerServices(database, configuration, execution, adapters);
      }
      done = runPreviewWorker(services.dependencies, shutdown.signal, { monitorIntervalMs: 100, pollIntervalMs: 50 });
      // Observe rejection immediately, even when a later explicit assertion checks failed shutdown.
      void done.catch(() => {});
      if (scenario !== "unknown-startup" && scenario !== "old-executor") {
        await waitFor(async () => (await snapshot())?.status === "ready");
        expect(services.runtime(admitted.previewId)?.ingressUrl).toBe("http://127.0.0.1:1234");
        if (scenario === "revocation") {
          await database.update(schema.projectMembers).set({ role: "viewer" })
            .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, "db-editor")));
        } else if (scenario === "shutdown") shutdown.abort();
        else expect(await stopPreview(database, admitted.previewId, "db-editor")).toBe(true);
      }
      if (scenario === "cleanup-failure") {
        await waitFor(async () => removals.length > 0);
        shutdown.abort();
        await expect(done).rejects.toThrow("cleanup");
        expect(removals).toEqual(["application"]);
        expect((await snapshot())?.cleanupCompletedAt).toBeNull();
        const [runtime] = await database.select().from(schema.previewDatabaseRuntime)
          .where(eq(schema.previewDatabaseRuntime.previewId, admitted.previewId));
        expect(runtime?.cleanupEffect?.kind).toBe("application");
        const row = await snapshot();
        if (!row?.claimToken || !runtime?.cleanupToken) throw new Error("Missing retained recovery identity");
        const claim = { previewId: row.id, buildId, projectId, token: row.claimToken };
        const replacement = createDatabasePreviewWorkerServices(database, configuration, execution, adapters);
        await expect(replacement.dependencies.reconcile(async () => {})).rejects.toMatchObject({ status: 409 });
        expect(removals).toEqual(["application"]);
        // Explicit caller recovery reuses the original live cleanup claim, never an automatic poll retry.
        failCleanup = false;
        const held = (): void => execution.assertHeld(claim);
        const cleanupClaim = await beginPreviewDatabaseCleanup(database, claim, runtime.cleanupToken, held);
        await cleanupPreviewDatabaseRuntime(database, cleanupClaim, directory, new AbortController().signal, held, adapters.cleanup);
        await execution.release(claim);
        expect(removals).toEqual(["application", "application", "socket", "sessions", "artifact"]);
      } else {
        await waitFor(async () => Boolean((await snapshot())?.cleanupCompletedAt));
        shutdown.abort(); await done;
        expect(removals).toEqual(["application", "socket", "sessions", "artifact"]);
      }
      expect(effects).toEqual(["prepare", "socket", "application"]);
      expect(services.runtime(admitted.previewId)).toBeNull();
      expect((await snapshot())?.cleanupCompletedAt).not.toBeNull();
      if (scenario === "old-executor") expect(recovered).toBe(1);
      const [resource] = await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      expect(resource?.revision).toBe(resourceRevision);
    } finally {
      shutdown.abort(); await done?.catch(() => {});
      for (const lock of locks.values()) await lock.release();
      await database.update(schema.projectMembers).set({ role: "editor" })
        .where(and(eq(schema.projectMembers.projectId, projectId), eq(schema.projectMembers.userId, "db-editor")));
      await database.delete(schema.previews).where(eq(schema.previews.id, admitted.previewId));
    }
  }
}
