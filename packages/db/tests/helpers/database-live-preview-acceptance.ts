/** Native acceptance joins saved application validation, reviewed schema and the actual preview host. */
import { expect } from "bun:test";
import { eq } from "drizzle-orm";
import { resolve } from "node:path";
import type { db } from "../../src";
import * as schema from "../../src/schema";
import { databaseApplication } from "../fixtures/database-application";
import { executeDatabaseBuildValidation } from "../../../../apps/api/src/modules/databases/validation/build-validation";
import { finishBuild } from "../../../../apps/api/src/modules/builds/persistence/build-job-store";
import { parseApiEnvironment } from "../../../../apps/api/src/config/api-environment";
import { startProductionDatabasePreviewWorker } from "../../../../apps/api/src/modules/databases/preview-runtime/production-preview-worker";
import { createPreviewHttpHandlers } from "../../../../apps/api/src/modules/previews/http/http";
import { getOwnedPreview } from "../../../../apps/api/src/modules/previews/persistence/preview-store";
import { databasePreviewIsReady } from "../../../../apps/api/src/modules/databases/bindings/preview-readiness";

/** The app uses row one for CRUD; row two remains available for the existing reader checks. */
export function databasePreviewApplication(framework: "nextjs" | "laravel"): Array<{ path: string; content: string }> {
  return databaseApplication(framework).map(file => {
    if (framework === "nextjs" && file.path.endsWith(".sql")) return { ...file,
      content: file.content + "\n--> statement-breakpoint\nINSERT INTO notes(id,body) VALUES (2,'Shared reader fixture');" };
    if (framework === "laravel" && file.path.startsWith("database/migrations/")) return { ...file,
      content: file.content.replace("$table->text('body'); });", "$table->text('body'); }); \\Illuminate\\Support\\Facades\\DB::table('notes')->insert(['id'=>2,'body'=>'Shared reader fixture']);") };
    return file;
  });
}
/** Fixed fixture source exercises the real saved-parent validator; no model call or operator database is used. */
export async function validatePreviewBuild(database: typeof db, input: {
  projectId: string; buildId: string; framework: "nextjs" | "laravel"; resourceId: string; revision: string;
}): Promise<void> {
  const token = crypto.randomUUID();
  const savedInput = { prompt: "Combined fixture", stack: input.framework, provider: "fixture", model: "fixture", previousFiles: [], previousErrors: [],
    databaseV1: { version: 1 as const, environment: "development" as const, resourceId: input.resourceId, resourceRevision: input.revision } };
  await database.update(schema.builds).set({ status: "building", attemptCount: 1 }).where(eq(schema.builds.id, input.buildId));
  await database.insert(schema.buildJobs).values({ buildId: input.buildId, projectId: input.projectId, userId: "db-owner", status: "running",
    idempotencyKey: crypto.randomUUID(), requestIdentity: "combined-fixture", claimToken: token, leaseExpiresAt: new Date(Date.now() + 600_000), input: savedInput });
  const claim = { buildId: input.buildId, projectId: input.projectId, token, input: savedInput };
  const result = await executeDatabaseBuildValidation(database, claim, { operationId: crypto.randomUUID(), requestId: crypto.randomUUID(),
    resourceId: input.resourceId, resourceRevision: input.revision, deadlineAt: Date.now() + 300_000 }, AbortSignal.timeout(300_000));
  expect(result.outcome.status).toBe("success");
  await finishBuild(database, claim, { status: "success" });
}
/** Admit through the real HTTP boundary, fetch through owned ingress, then await preview cleanup. */
export async function verifyLiveDatabasePreview(database: typeof db, input: { projectId: string; buildId: string; directory: string }): Promise<void> {
  const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: "postgresql://fixture@localhost/unused", WRENLY_DATA_DIR: input.directory,
    WRENLY_AUTH_SECRET: "combined-fixture-secret-at-least-32-characters", WRENLY_APP_URL: "http://localhost:3002",
    WRENLY_PREVIEW_ENABLED: "true", WRENLY_APP_DATABASES_ENABLED: "true" });
  const bundle = await Bun.build({ target: "bun", env: "disable", entrypoints: [resolve(import.meta.dir,
    "../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts")] });
  if (!bundle.success || !bundle.outputs[0]) throw new Error("Trusted ingress unavailable");
  const worker = await startProductionDatabasePreviewWorker(database, environment, new Uint8Array(await bundle.outputs[0].arrayBuffer()));
  const handlers = createPreviewHttpHandlers(database, { enabled: true, databasesEnabled: true, baseUrl: environment.WRENLY_PREVIEW_BASE_URL,
    user: async () => ({ id: "db-owner", authSessionId: "fixture" }) });
  let previewId: string | undefined;
  try {
    const key = crypto.randomUUID(), admissionDeadline = Date.now() + 15_000;
    let response: Response;
    while (true) {
      response = await handlers.create(new Request("http://localhost/preview", { method: "POST", headers: { "Idempotency-Key": key } }), input.buildId);
      if (response.status !== 503 || Date.now() >= admissionDeadline) break;
      // A polling worker can hold NOWAIT queue locks. Keep the same identity even if acknowledgement was lost.
      await response.body?.cancel(); await Bun.sleep(50);
    }
    expect([200, 202]).toContain(response.status);
    const acknowledgement: unknown = await response.json();
    if (!acknowledgement || typeof acknowledgement !== "object" || !("previewId" in acknowledgement) || typeof acknowledgement.previewId !== "string") throw new Error("Preview admission failed");
    previewId = acknowledgement.previewId;
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      const snapshot = await getOwnedPreview(database, previewId, "db-owner");
      if (snapshot?.status === "ready") break;
      if (snapshot && ["failed", "interrupted"].includes(snapshot.status)) throw new Error(`Preview ${snapshot.status}: ${snapshot.error}`);
      await Bun.sleep(100);
    }
    expect((await getOwnedPreview(database, previewId, "db-owner"))?.status).toBe("ready");
    const runtime = worker.runtime(previewId);
    if (!runtime) throw new Error("Preview missing from owned runtime map");
    const [saved] = await database.select().from(schema.previews).where(eq(schema.previews.id, previewId));
    if (!saved) throw new Error("Saved preview missing");
    expect(await databasePreviewIsReady(database, saved)).toBe(true);
    const host = new URL(environment.WRENLY_PREVIEW_BASE_URL); host.hostname = `${previewId}.${host.hostname}`;
    const page = await fetch(runtime.ingressUrl, { headers: { Host: host.host, "x-wrenly-preview-ingress": runtime.capability }, signal: AbortSignal.timeout(30_000) });
    expect(page.status).toBe(200); expect(await page.text()).toContain("Runtime database CRUD verified");
    expect((await handlers.stop(new Request("http://localhost/preview", { method: "POST" }), previewId)).status).toBe(200);
  } finally { await worker.stop(); }
  if (previewId) {
    expect(worker.runtime(previewId)).toBeNull();
    expect((await getOwnedPreview(database, previewId, "db-owner"))?.cleanupPending).toBe(false);
  }
}
