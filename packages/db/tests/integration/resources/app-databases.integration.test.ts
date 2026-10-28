import { acknowledgeFailedValidationArtifact } from "../../../../../apps/api/src/modules/databases/validation/validation-artifact-store";
import { databasePreviewApplication, validatePreviewBuild, verifyLiveDatabasePreview } from "../../helpers/database-live-preview-acceptance";
import { readDatabaseMigrationReview } from "../../../../../apps/api/src/modules/databases/database-review-store";
import { readDatabaseRecoveryReview } from "../../../../../apps/api/src/modules/databases/database-recovery-review";
import { databaseApplication } from "../../fixtures/database-application";
import { verifyPreviewRuntimeStorage } from "../../helpers/preview-runtime-acceptance";
import { executeDatabaseBuildValidation } from "../../../../../apps/api/src/modules/databases/validation/build-validation";
import { RuntimeArtifactCompilationError, prepareDatabaseValidationArtifact, cleanupRuntimeArtifactPreparation } from "../../../../sandbox/src/artifacts/runtime-artifact";
import { readValidatedDatabaseRevision } from "../../../../../apps/api/src/modules/databases/bindings/validated-revision";
import { databaseValidationSourceDigest } from "../../../../../apps/api/src/modules/databases/validation/source-identity";
import { recoverDatabaseValidation } from "../../../../../apps/api/src/modules/databases/validation/validation-recovery";
import { executeDatabaseValidation } from "../../../../../apps/api/src/modules/databases/validation/validation-executor";
import { appDatabaseSource } from "../../fixtures/app-database-source";
import { beginDatabaseValidation, beginDatabaseValidationPreparation, assertDatabaseValidation, renewDatabaseValidation, loadDatabaseValidation, verifyDatabaseValidationSchema } from "../../../../../apps/api/src/modules/databases/validation/validation-store";
import { readDatabaseRevisionBinding, assertDatabaseRevisionBinding } from "../../../../../apps/api/src/modules/databases/bindings/revision-binding";
import { createDatabaseRecoveryHandlers } from "../../../../../apps/api/src/modules/databases/http/recovery";
import { admitDatabaseRecovery } from "../../../../../apps/api/src/modules/databases/database-recovery-admission";
import { DatabaseActionAcknowledgement } from "../../../src/application-databases/action-contract";
import { recoverDatabaseRead } from "../../../../../apps/api/src/modules/databases/viewing/view-recovery";
import { createDatabaseResourceStatusHandler } from "../../../../../apps/api/src/modules/databases/http/resource-status";
import { DatabaseResourceStatus } from "../../../src/application-databases/resource-contract";
import { createDatabaseActionHandlers } from "../../../../../apps/api/src/modules/databases/http/actions";
import { readDatabaseActionAcknowledgement } from "../../../../../apps/api/src/modules/databases/http/action-acknowledgement-store";
import { loadDatabaseReadConnection } from "../../../../../apps/api/src/modules/databases/viewing/view-leases";
import { startDatabaseSocket } from "../../../../sandbox/src/databases/database-socket";
import { readAuthorizedDatabaseView } from "../../../../../apps/api/src/modules/databases/viewing/view-service";
import { runDatabaseViewQuery } from "../../../../../apps/api/src/modules/databases/viewing/view-runtime";
import { beginDatabaseRead, assertDatabaseRead, finishDatabaseRead } from "../../../../../apps/api/src/modules/databases/viewing/view-leases";
import { readDatabaseViewAuthority } from "../../../../../apps/api/src/modules/databases/viewing/view-authority";
import { laravelFixture } from "../../../../sandbox/tests/laravel-fixture";
import { pgTable, uuid, text } from "drizzle-orm/pg-core";
// Uses only an explicitly named disposable database; this does not activate the product module.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import { createProductionDatabaseWorker } from "../../../../../apps/api/src/modules/databases/production-database-worker";
import {
  admitDatabaseAction,
  readDatabaseResources,
  claimDatabaseAction,
  loadDatabaseExecution,
  renewDatabaseAction,
  interruptExpiredDatabaseActions,
  verifyDatabaseSchema,
  recordDatabaseEffect,
  acknowledgeDatabaseEffect,
  finishDatabaseAction,
  hasDatabaseWork,
  interruptDatabaseAction,
  recordDatabaseCleanupEffect,
  acknowledgeDatabaseCleanupEffect,
} from "../../../../../apps/api/src/modules/databases/database-store";

import { acquireDatabaseExecutorLock } from "../../../../../apps/api/src/modules/databases/database-executor-lock";
import {
  recoverInspectedDatabaseAction,
  recoverUnstartedDatabaseAction,
} from "../../../../../apps/api/src/modules/databases/database-recovery";

import { admitBuild } from "../../../../../apps/api/src/modules/builds/admission/build-admission";
import { admitConversationBuildAction } from "../../../../../apps/api/src/modules/conversations/execution/conversation-actions";
import { admitConversationTurn, claimConversationTurn, completeConversationAnswer } from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
import { admitPreview, admitDatabasePreview, claimNextPreview } from "../../../../../apps/api/src/modules/previews/persistence/preview-store";
import { assertPreviewDatabaseBinding } from "../../../../../apps/api/src/modules/databases/bindings/preview-binding";
import { claimNextDatabasePreview } from "../../../../../apps/api/src/modules/databases/bindings/preview-claim";
import { admitDeployment } from "../../../../../apps/api/src/modules/deployments/persistence/deployment-store";
import { changeProjectSharing } from "../../../../../apps/api/src/modules/projects/sharing/project-sharing";
import { changeProjectModel } from "../../../../../apps/api/src/modules/projects/sharing/project-model";
import { hasMemberDatabaseWork } from "../../../../../apps/api/src/modules/databases/database-activity";
import { readAppDatabaseManifest } from "../../../../sandbox/src/databases/database-manifest";

const url = process.env.WRENLY_TEST_APP_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_app_database_test"
  )
    throw new Error(
      "Use only a disposable local wrenly_app_database_test database.",
    );
}
const integration = url ? describe : describe.skip;
// Cold PostgreSQL initialization plus the full migration history may exceed Bun's 5s hook default.
const FIXTURE_SETUP_TIMEOUT_MS = 30_000;
// Each framework exercises multiple independent preparation/startup/recovery claims and real key/kernel I/O.
// This fixture budget does not change any application, lease or sandbox deadline.
const FIXTURE_LIFECYCLE_TIMEOUT_MS = 90_000;
integration("generated-app database metadata lifecycle", () => {
  const client = postgres(
    url ?? "postgresql://localhost/wrenly_app_database_test",
    { onnotice: () => {} },
  );
  const database = drizzle(client, { schema });
  let directory = "";
  const projectId = crypto.randomUUID();
  const actors = [
    "db-owner",
    "db-editor",
    "db-viewer",
    "db-admin",
    "db-outsider",
  ];
  const create = (): {
    requestId: string;
    expectedRevision: null;
    environment: "development";
    kind: "create";
  } => ({
    requestId: crypto.randomUUID(),
    expectedRevision: null,
    environment: "development",
    kind: "create",
  });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wrenly-app-database-test-"));
    const previous = join(directory, "previous");
    await mkdir(join(previous, "meta"), { recursive: true });
    const folder = join(import.meta.dir, "../../../migrations");
    const journal = JSON.parse(
      await readFile(join(folder, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const old = {
      ...journal,
      entries: journal.entries.filter((entry) => entry.idx < 24),
    };
    await writeFile(join(previous, "meta/_journal.json"), JSON.stringify(old));
    for (const entry of old.entries)
      await copyFile(
        join(folder, `${entry.tag}.sql`),
        join(previous, `${entry.tag}.sql`),
      );
    await migrate(database, { migrationsFolder: previous });
    await database
      .insert(schema.user)
      .values(
        actors.map((id) => ({ id, name: id, email: `${id}@example.test` })),
      );
    await database.insert(schema.organization).values({
      id: "db-instance",
      name: "Fixture",
      slug: "db-fixture",
      createdAt: new Date(),
    });
    await database.insert(schema.instanceSetup).values({
      id: 1,
      ownerId: "db-admin",
      organizationId: "db-instance",
      initializedAt: new Date(),
    });
    await database.insert(schema.member).values(
      actors
        .filter((id) => id !== "db-outsider")
        .map((id) => ({
          id,
          organizationId: "db-instance",
          userId: id,
          role: id === "db-admin" ? "owner" : "member",
          createdAt: new Date(),
        })),
    );
    const legacyProjects = pgTable("projects", {
      id: uuid("id"),
      userId: text("user_id"),
      name: text("name"),
      accessMode: text("access_mode"),
    });
    await database.insert(legacyProjects).values({
      id: projectId,
      userId: "db-owner",
      name: "Database fixture",
      accessMode: "selected",
    });
    await database.insert(schema.projectMembers).values([
      { projectId, userId: "db-editor", role: "editor" },
      { projectId, userId: "db-viewer", role: "viewer" },
    ]);
    await expect(verifyDatabaseSchema(database)).rejects.toThrow("0025");
    await migrate(database, { migrationsFolder: folder });
  }, FIXTURE_SETUP_TIMEOUT_MS);
  afterAll(async () => {
    await client.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  test("upgrade preserves project ownership, has no automatic resources and is repeatable", async () => {
    await verifyDatabaseSchema(database);
    await migrate(database, {
      migrationsFolder: join(import.meta.dir, "../../../migrations"),
    });
    expect(
      (
        await database
          .select()
          .from(schema.projects)
          .where(eq(schema.projects.id, projectId))
      )[0]?.userId,
    ).toBe("db-owner");
    expect(
      (await readDatabaseResources(database, projectId, "db-owner")).resources,
    ).toEqual([]);
  });
  for (const framework of ["nextjs", "laravel"] as const) test(process.env.WRENLY_TEST_DATABASE_PREVIEW_WORKER_ONLY === "true"
    ? `database preview worker stop/shutdown/recovery (${framework})`
    : `revision bindings require applied source/schema and current access (${framework})`, async () => {
    const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID();
    const buildId = crypto.randomUUID(), operationId = crypto.randomUUID(), schemaDigest = "c".repeat(64);
    const path = framework === "nextjs" ? "drizzle/0000_notes.sql" : "database/migrations/2026_10_24_000000_notes.php";
    const files = framework === "nextjs" ? [
      { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: { engine: "postgresql", adapter: "drizzle-postgres", migrations: [path] } }) },
      { path, content: "CREATE TABLE notes(id integer PRIMARY KEY);" },
      { path: "drizzle/meta/_journal.json", content: JSON.stringify({ dialect: "postgresql", entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }] }) },
    ] : [...laravelFixture(),
      { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: { engine: "postgresql", adapter: "laravel", migrations: [path] } }) },
      { path, content: String.raw`<?php return new class extends \Illuminate\Database\Migrations\Migration { public function up(): void {} public function down(): void {} };` },
    ];
    const manifest = readAppDatabaseManifest(files, framework)!;
    expect(manifest).not.toBeNull();
    try {
    await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Revision binding", stack: framework, accessMode: "selected" });
    await database.insert(schema.projectMembers).values([{ projectId: project, userId: "db-editor", role: "editor" }, { projectId: project, userId: "db-viewer", role: "viewer" }]);
    await database.insert(schema.builds).values({ id: buildId, projectId: project, prompt: "Fixture", stack: framework, status: "success", files });
    // Metadata-only fixtures test selection/authority, not actual DDL or application readiness.
    await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision, schemaDigest,
      createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE_NEVER_PROJECT" } });
    const reviewed = await readDatabaseMigrationReview(database, project, "db-owner", resourceId, buildId);
    expect(reviewed.migrationDigest).toBe(manifest.digest);
    expect(reviewed.files.map(file => file.path)).toEqual(manifest.files.map(file => file.path));
    expect(reviewed.backups).toEqual([]);
    expect(JSON.stringify(reviewed)).not.toContain("PRIVATE_NEVER_PROJECT");
    await expect(readDatabaseMigrationReview(database, project, "db-editor", resourceId, buildId)).rejects.toMatchObject({ status: 403 });
    await expect(readDatabaseMigrationReview(database, project, "db-owner", resourceId, crypto.randomUUID())).rejects.toMatchObject({ status: 409 });
    const input = { buildId, resourceId, resourceRevision: revision, environment: "development" };
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.insert(schema.appDatabaseOperations).values({ id: operationId, databaseId: resourceId, projectId: project, actorId: "db-owner", requestId: crypto.randomUUID(), requestIdentity: "fixture", kind: "migrate", status: "success", buildId, migrationDigest: manifest.digest, completedAt: new Date() });
    await database.insert(schema.appDatabaseMigrations).values({ databaseId: resourceId, operationId, buildId, digest: manifest.digest, rehearsedSchemaDigest: schemaDigest, manifest: manifest.files, completedAt: new Date() });
    const binding = await readDatabaseRevisionBinding(database, project, "db-owner", input);
    await expect(readValidatedDatabaseRevision(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    const validationId = crypto.randomUUID();
    await database.insert(schema.appDatabaseOperations).values({ id: validationId, databaseId: resourceId, projectId: project, actorId: "db-owner", requestId: crypto.randomUUID(), requestIdentity: "validation-evidence-fixture", kind: "validate-application", status: "success", buildId, migrationDigest: manifest.digest, completedAt: new Date() });
    await database.insert(schema.appDatabaseValidations).values({ operationId: validationId, buildId, buildToken: crypto.randomUUID(), accessRevision: binding.accessRevision,
      resourceRevision: crypto.randomUUID(), framework, files, sourceDigest: databaseValidationSourceDigest(files), migrationDigest: manifest.digest,
      imageId: `sha256:${"a".repeat(64)}`, deadlineAt: new Date(Date.now() - 1000), schemaDigest });
    // Evidence selection is metadata-only here; real executor acceptance runs separately below.
    const eligible = await readValidatedDatabaseRevision(database, project, "db-viewer", input);
    expect(eligible).toEqual({ binding, validationOperationId: validationId, sourceDigest: databaseValidationSourceDigest(files) });
    expect(JSON.stringify(eligible)).not.toContain("PRIVATE");
    const changedApp = framework === "laravel"
      ? files.map(file => file.path === "routes/web.php" ? { ...file, content: file.content + "\n// Changed application, same migrations\n" } : file)
      : [...files, { path: "app/page.jsx", content: "export default function Page() { return <p>Changed application</p> }" }];
    await database.update(schema.builds).set({ files: changedApp }).where(eq(schema.builds.id, buildId));
    if (framework === "laravel") {
      // Artisan boots application source: its existing migration review already binds every file.
      await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    } else {
      expect(await readDatabaseRevisionBinding(database, project, "db-owner", input)).toEqual(binding);
    }
    await expect(readValidatedDatabaseRevision(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.builds).set({ files }).where(eq(schema.builds.id, buildId));
    await database.update(schema.appDatabaseValidations).set({ schemaDigest: "d".repeat(64) }).where(eq(schema.appDatabaseValidations.operationId, validationId));
    await expect(readValidatedDatabaseRevision(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabaseValidations).set({ schemaDigest, files: changedApp }).where(eq(schema.appDatabaseValidations.operationId, validationId));
    await expect(readValidatedDatabaseRevision(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabaseValidations).set({ files }).where(eq(schema.appDatabaseValidations.operationId, validationId));
    await database.update(schema.appDatabaseOperations).set({ status: "failed" }).where(eq(schema.appDatabaseOperations.id, validationId));
    await expect(readValidatedDatabaseRevision(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabaseOperations).set({ status: "success" }).where(eq(schema.appDatabaseOperations.id, validationId));
    const selection = { version: 1 as const, environment: "development" as const, resourceId, resourceRevision: revision };
    await expect(admitDatabasePreview(database, buildId, "db-editor", crypto.randomUUID(), selection)).rejects.toMatchObject({ status: 409 });
    await database.insert(schema.buildJobs).values({ buildId, projectId: project, userId: "db-owner", status: "success", idempotencyKey: crypto.randomUUID(), requestIdentity: "preview-evidence-fixture",
      input: { prompt: "Fixture", stack: framework, provider: "fixture", model: "fixture", previousFiles: [], previousErrors: [], databaseV1: { ...selection, resourceRevision: crypto.randomUUID() } } });
    await expect(admitPreview(database, buildId, "db-editor", crypto.randomUUID())).rejects.toMatchObject({ status: 409 });
    await expect(admitDatabasePreview(database, buildId, "db-viewer", crypto.randomUUID(), selection)).rejects.toMatchObject({ status: 403 });
    await expect(admitDatabasePreview(database, buildId, "db-editor", crypto.randomUUID(), { ...selection, resourceRevision: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect((await database.select().from(schema.previews).where(eq(schema.previews.projectId, project))).length).toBe(0);
    const previewKey = crypto.randomUUID();
    const preview = await admitDatabasePreview(database, buildId, "db-editor", previewKey, selection);
    expect(await admitDatabasePreview(database, buildId, "db-editor", previewKey, selection)).toEqual({ ...preview, replayed: true });
    await expect(admitDatabasePreview(database, buildId, "db-editor", previewKey, { ...selection, resourceRevision: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    const [savedPreview] = await database.select().from(schema.previewDatabaseBindings).where(eq(schema.previewDatabaseBindings.previewId, preview.previewId));
    expect(savedPreview?.revision).toEqual(eligible); expect(JSON.stringify(savedPreview)).not.toContain("PRIVATE");
    expect(await claimNextPreview(database)).toBeNull();
    await database.update(schema.previews).set({ files: changedApp }).where(eq(schema.previews.id, preview.previewId));
    await expect(claimNextDatabasePreview(database)).rejects.toMatchObject({ status: 409 });
    expect((await database.select().from(schema.previews).where(eq(schema.previews.id, preview.previewId)))[0]?.status).toBe("queued");
    await database.update(schema.previews).set({ files }).where(eq(schema.previews.id, preview.previewId));
    const previewClaim = await claimNextDatabasePreview(database);
    if (!previewClaim) throw new Error("Expected explicit database preview claim");
    expect(previewClaim.stack).toBe(framework); expect(previewClaim.database).toEqual(eligible);
    expect(await claimNextDatabasePreview(database)).toBeNull();
    expect(await assertPreviewDatabaseBinding(database, previewClaim)).toEqual(eligible);
    await expect(assertPreviewDatabaseBinding(database, { ...previewClaim, token: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
    await database.update(schema.previews).set({ files: changedApp }).where(eq(schema.previews.id, preview.previewId));
    await expect(assertPreviewDatabaseBinding(database, previewClaim)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.previews).set({ files }).where(eq(schema.previews.id, preview.previewId));
    await database.update(schema.projectMembers).set({ role: "viewer" }).where(eq(schema.projectMembers.projectId, project));
    await expect(assertPreviewDatabaseBinding(database, previewClaim)).rejects.toMatchObject({ status: 409 });
    // Restore both seeded roles exactly; tests below also check ordinary Viewer metadata reads.
    await database.update(schema.projectMembers).set({ role: "editor" }).where(and(eq(schema.projectMembers.projectId, project), eq(schema.projectMembers.userId, "db-editor")));
    await database.update(schema.appDatabaseValidations).set({ schemaDigest: "d".repeat(64) }).where(eq(schema.appDatabaseValidations.operationId, validationId));
    await expect(assertPreviewDatabaseBinding(database, previewClaim)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabaseValidations).set({ schemaDigest }).where(eq(schema.appDatabaseValidations.operationId, validationId));
    await database.update(schema.previews).set({ leaseExpiresAt: new Date(Date.now() - 1) }).where(eq(schema.previews.id, preview.previewId));
    await expect(assertPreviewDatabaseBinding(database, previewClaim)).rejects.toMatchObject({ status: 409 });
    await database.delete(schema.previews).where(eq(schema.previews.projectId, project));
    await verifyPreviewRuntimeStorage(database, directory, project, buildId, resourceId, revision);
    expect(binding.framework).toBe(framework);
    expect(JSON.stringify(binding)).not.toContain("PRIVATE");
    await assertDatabaseRevisionBinding(database, "db-owner", binding);
    expect(await readDatabaseRevisionBinding(database, project, "db-viewer", input)).toEqual(binding);
    await expect(readDatabaseRevisionBinding(database, project, "db-admin", input)).rejects.toMatchObject({ status: 404 });
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", { ...input, environment: "production" })).rejects.toMatchObject({ status: 400 });
    expect(await readDatabaseRevisionBinding(database, project, "db-editor", input)).toEqual(binding);
    await database.update(schema.builds).set({ status: "failed" }).where(eq(schema.builds.id, buildId));
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.builds).set({ status: "success" }).where(eq(schema.builds.id, buildId));
    await database.update(schema.appDatabases).set({ status: "stopped" }).where(eq(schema.appDatabases.id, resourceId));
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabases).set({ status: "ready" }).where(eq(schema.appDatabases.id, resourceId));
    const pendingId = crypto.randomUUID();
    await database.insert(schema.appDatabaseOperations).values({ id: pendingId, databaseId: resourceId, projectId: project, actorId: "db-owner", requestId: crypto.randomUUID(), requestIdentity: "pending-fixture", kind: "read", status: "interrupted" });
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, pendingId));
    const latestId = crypto.randomUUID();
    await database.insert(schema.appDatabaseOperations).values({ id: latestId, databaseId: resourceId, projectId: project, actorId: "db-owner", requestId: crypto.randomUUID(), requestIdentity: "later-fixture", kind: "migrate", status: "success", buildId, migrationDigest: "e".repeat(64), completedAt: new Date(Date.now() + 1000) });
    await database.insert(schema.appDatabaseMigrations).values({ databaseId: resourceId, operationId: latestId, buildId, digest: "e".repeat(64), rehearsedSchemaDigest: schemaDigest, manifest: manifest.files, completedAt: new Date() });
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    await database.delete(schema.appDatabaseMigrations).where(eq(schema.appDatabaseMigrations.operationId, latestId));
    await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, latestId));
    await database.update(schema.builds).set({ files: files.map(file => file.path === path ? { ...file, content: file.content + "\n" } : file) }).where(eq(schema.builds.id, buildId));
    await expect(assertDatabaseRevisionBinding(database, "db-owner", binding)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.builds).set({ files }).where(eq(schema.builds.id, buildId));
    await database.update(schema.projects).set({ accessRevision: crypto.randomUUID() }).where(eq(schema.projects.id, project));
    await expect(assertDatabaseRevisionBinding(database, "db-owner", binding)).rejects.toMatchObject({ status: 409 });
    const refreshed = await readDatabaseRevisionBinding(database, project, "db-owner", input);
    await database.update(schema.appDatabases).set({ schemaDigest: "d".repeat(64) }).where(eq(schema.appDatabases.id, resourceId));
    await expect(assertDatabaseRevisionBinding(database, "db-owner", refreshed)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabases).set({ schemaDigest, revision: crypto.randomUUID() }).where(eq(schema.appDatabases.id, resourceId));
    await expect(assertDatabaseRevisionBinding(database, "db-owner", refreshed)).rejects.toMatchObject({ status: 409 });
    await database.update(schema.appDatabases).set({ revision }).where(eq(schema.appDatabases.id, resourceId));
    await database.update(schema.projects).set({ archivedAt: new Date() }).where(eq(schema.projects.id, project));
    await expect(readDatabaseRevisionBinding(database, project, "db-owner", input)).rejects.toMatchObject({ status: 409 });
    } finally {
      await database.delete(schema.previews).where(eq(schema.previews.projectId, project));
      await database.delete(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.buildId, buildId));
      await database.delete(schema.appDatabaseMigrations).where(eq(schema.appDatabaseMigrations.databaseId, resourceId));
      await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.databaseId, resourceId));
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      await database.delete(schema.builds).where(eq(schema.builds.projectId, project));
      await database.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  }, FIXTURE_LIFECYCLE_TIMEOUT_MS);
  for (const framework of ["nextjs", "laravel"] as const) test(`disposable validation admission freezes source and fences parent claims (${framework})`, async () => {
    const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID();
    const buildId = crypto.randomUUID(), buildToken = crypto.randomUUID(), actor = framework === "laravel" ? "db-editor" : "db-owner";
    const path = framework === "nextjs" ? "drizzle/0000_notes.sql" : "database/migrations/2026_10_24_000000_notes.php";
    const files = framework === "nextjs" ? [
      { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: { engine: "postgresql", adapter: "drizzle-postgres", migrations: [path] } }) },
      { path, content: "CREATE TABLE notes(id integer PRIMARY KEY);" },
      { path: "drizzle/meta/_journal.json", content: JSON.stringify({ dialect: "postgresql", entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }] }) },
    ] : [...laravelFixture(),
      { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: { engine: "postgresql", adapter: "laravel", migrations: [path] } }) },
      { path, content: "<?php // Metadata validation fixture" },
    ];
    const manifest = readAppDatabaseManifest(files, framework)!;
    const input = { operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), buildId, buildToken, resourceId, resourceRevision: revision,
      migrationDigest: manifest.digest, imageId: `sha256:${"a".repeat(64)}`, remainingMs: 60_000 };
    try {
      await verifyDatabaseValidationSchema(database);
      await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Validation fixture", stack: framework, accessMode: "selected" });
      await database.insert(schema.projectMembers).values([{ projectId: project, userId: "db-editor", role: "editor" }, { projectId: project, userId: "db-viewer", role: "viewer" }]);
      await database.insert(schema.builds).values({ id: buildId, projectId: project, prompt: "Fixture", stack: framework, status: "building", files });
      await database.insert(schema.buildJobs).values({ buildId, projectId: project, userId: actor, idempotencyKey: crypto.randomUUID(), requestIdentity: "fixture", status: "running", claimToken: buildToken,
        leaseExpiresAt: new Date(Date.now() + 120_000), input: { prompt: "Fixture", stack: framework, model: "fixture", provider: "fixture", previousFiles: [], previousErrors: [] } });
      await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision,
        createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE" } });
      await expect(beginDatabaseValidation(database, project, "db-viewer", input)).rejects.toMatchObject({ status: 403 });
      await expect(beginDatabaseValidation(database, project, actor, { ...input, buildToken: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
      const claim = await beginDatabaseValidation(database, project, actor, input);
      expect(await hasDatabaseWork(database, project)).toBe(true);
      await assertDatabaseValidation(database, claim);
      const frozen = await loadDatabaseValidation(database, claim);
      expect(frozen.files).toEqual(files); expect(frozen.framework).toBe(framework);
      expect(frozen.remainingMs).toBeGreaterThan(0); expect(frozen.remainingMs).toBeLessThanOrEqual(60_000);
      DatabaseResourceStatus.parse(await readDatabaseResources(database, project, actor));
      await renewDatabaseValidation(database, claim);
      await recordDatabaseEffect(database, claim, { kind: "create-network", id: "disposable-network" });
      await expect(acknowledgeDatabaseEffect(database, claim, "disposable-network", { version: 1, containerId: "disposable", networkId: "disposable", volumeName: "disposable", imageId: input.imageId })).rejects.toMatchObject({ status: 409 });
      await acknowledgeDatabaseEffect(database, claim, "disposable-network");
      await expect(beginDatabaseValidation(database, project, actor, input)).rejects.toMatchObject({ status: 409 });
      expect((await database.select().from(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.buildId, buildId))).length).toBe(1);
      await expect(assertDatabaseValidation(database, { ...claim, token: crypto.randomUUID() })).rejects.toMatchObject({ status: 409 });
      await database.update(schema.buildJobs).set({ cancelRequestedAt: new Date() }).where(eq(schema.buildJobs.buildId, buildId));
      await expect(assertDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
      await database.update(schema.buildJobs).set({ cancelRequestedAt: null }).where(eq(schema.buildJobs.buildId, buildId));
      await database.update(schema.builds).set({ files: [...files, { path: "changed.txt", content: "Changed source" }] }).where(eq(schema.builds.id, buildId));
      await expect(assertDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
      await database.update(schema.builds).set({ files }).where(eq(schema.builds.id, buildId));
      await database.update(schema.appDatabases).set({ revision: crypto.randomUUID() }).where(eq(schema.appDatabases.id, resourceId));
      await expect(assertDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
      await database.update(schema.appDatabases).set({ revision }).where(eq(schema.appDatabases.id, resourceId));
      const [projectBefore] = await database.select({ revision: schema.projects.accessRevision }).from(schema.projects).where(eq(schema.projects.id, project));
      if (!projectBefore) throw new Error("Missing validation project");
      await database.update(schema.projects).set({ accessRevision: crypto.randomUUID() }).where(eq(schema.projects.id, project));
      await expect(assertDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
      await database.update(schema.projects).set({ accessRevision: projectBefore.revision }).where(eq(schema.projects.id, project));
      await database.update(schema.buildJobs).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.buildJobs.buildId, buildId));
      await expect(assertDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
      await database.update(schema.buildJobs).set({ leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(schema.buildJobs.buildId, buildId));
      await database.update(schema.appDatabaseValidations).set({ deadlineAt: new Date(Date.now() - 1000) }).where(eq(schema.appDatabaseValidations.operationId, claim.id));
      await expect(renewDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
      const [resource] = await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      expect(resource?.runtimeIdentity).toBeNull(); expect(resource?.schemaDigest).toBeNull(); expect(resource?.revision).toBe(revision);
      await expect(finishDatabaseAction(database, claim, { success: true })).rejects.toMatchObject({ status: 409 });
      if (framework === "nextjs") await interruptDatabaseAction(database, claim);
      else {
        await database.update(schema.appDatabaseOperations).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.appDatabaseOperations.id, claim.id));
        await interruptExpiredDatabaseActions(database);
      }
      const [unchanged] = await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      expect(unchanged?.status).toBe("ready"); expect(unchanged?.revision).toBe(revision);
      expect(await hasDatabaseWork(database, project)).toBe(true);
      await expect(renewDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
    } finally {
      await database.delete(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.buildId, buildId));
      await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.projectId, project));
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      await database.delete(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId));
      await database.delete(schema.builds).where(eq(schema.builds.id, buildId));
      await database.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  });
  for (const framework of ["nextjs", "laravel"] as const) for (const scenario of ["success", "cancelled", "unknown", "mismatch", "preparation-unknown", "artifact-cleanup-unknown", "compilation-failed", "compilation-cleanup-unknown"] as const)
    test(`validation executor journals cleanup independently (${framework}/${scenario})`, async () => {
      const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID(), buildId = crypto.randomUUID(), buildToken = crypto.randomUUID();
      const files = appDatabaseSource(framework), migrationDigest = readAppDatabaseManifest(files, framework)!.digest;
      const controller = new AbortController();
      try {
        await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Execution fixture", stack: framework, accessMode: "selected" });
        await database.insert(schema.projectMembers).values([{ projectId: project, userId: "db-editor", role: "editor" }, { projectId: project, userId: "db-viewer", role: "viewer" }]);
        await database.insert(schema.builds).values({ id: buildId, projectId: project, prompt: "Fixture", stack: framework, status: "building", files });
        await database.insert(schema.buildJobs).values({ buildId, projectId: project, userId: "db-owner", idempotencyKey: crypto.randomUUID(), requestIdentity: "fixture", status: "running", claimToken: buildToken,
          leaseExpiresAt: new Date(Date.now() + 120_000), input: { prompt: "Fixture", stack: framework, model: "fixture", provider: "fixture", previousFiles: [], previousErrors: [] } });
        await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision,
          createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE" } });
        const ownsArtifact = framework === "laravel" || scenario === "preparation-unknown" || scenario === "artifact-cleanup-unknown" || scenario.startsWith("compilation-");
        const interrupted = ["unknown", "preparation-unknown", "artifact-cleanup-unknown", "compilation-cleanup-unknown"].includes(scenario);
        const claim = await (ownsArtifact ? beginDatabaseValidationPreparation : beginDatabaseValidation)(database, project, "db-owner", { operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), buildId, buildToken, resourceId, resourceRevision: revision,
          migrationDigest, ...(ownsArtifact ? {} : { imageId: `sha256:${"a".repeat(64)}` }), remainingMs: 60_000 });
        const artifactCleanup = async (id: string, held: () => Promise<void>): Promise<void> => { expect(id).toBe(claim.id); await held(); };
        // Controlled executor callbacks exercise the real journal/lease/lock protocol, not Docker or generated app readiness.
        const clean = async (cleanup: Parameters<typeof import("../../../../../apps/api/src/modules/databases/database-application-validation").validateFreshDatabaseApplication>[0]["cleanup"]): Promise<void> => {
          for (const kind of ["application", "socket", "database"] as const) {
            const id = kind === "database" ? `wrenly-database-${claim.id}` : `wrenly-database-${kind}-${claim.id}`;
            await cleanup.assertHeld(); await cleanup.beforeCleanup(kind, id); await cleanup.acknowledgeCleanup(kind, id);
          }
        };
        const outcome = await executeDatabaseValidation(database, claim, controller.signal, {
          prepare: async input => {
            expect(ownsArtifact).toBe(true); expect(input.deploymentId).toBe(claim.id); await input.beforeEffect();
            expect((await loadDatabaseValidation(database, claim)).imageId).toBeNull();
            if (scenario.startsWith("compilation-")) {
              const failure = new RuntimeArtifactCompilationError(claim.id, 1, "Type error: fixture component requires a title.");
              await expect(acknowledgeFailedValidationArtifact(database, claim, failure)).rejects.toMatchObject({ status: 409 });
              await expect(acknowledgeFailedValidationArtifact(database, claim, new RuntimeArtifactCompilationError(crypto.randomUUID(), 1, "wrong operation"))).rejects.toMatchObject({ status: 409 });
              throw failure;
            }
            if (scenario === "preparation-unknown") throw new Error("PRIVATE_PREPARATION_ACK_LOST");
            return { imageId: `sha256:${"a".repeat(64)}`, baseImageId: `sha256:${"b".repeat(64)}`, sizeBytes: 1 };
          },
          cleanupArtifact: async (id, held) => { await artifactCleanup(id, held); if (scenario === "artifact-cleanup-unknown" || scenario === "compilation-cleanup-unknown") throw new Error("PRIVATE_IMAGE_REFERENCE_UNKNOWN"); },
          validate: async input => {
            expect(input.files).toEqual(files); expect(input.sourceResourceId).toBe(resourceId); expect(input.operationId).not.toBe(resourceId);
            for (const kind of ["provision-roles", "apply-migrations", "enforce-policy", "inspect-schema", "create-container"] as const) {
              const effect = { kind, id: kind === "create-container" ? `wrenly-database-application-${claim.id}` : `fixture-${kind}` };
              await input.fence.beforeEffect(effect);
              if (scenario === "unknown" && kind === "apply-migrations") throw new Error("PRIVATE_UNCONFIRMED_SQL");
              await input.fence.acknowledgeEffect(effect);
            }
            if (scenario === "cancelled") {
              await database.update(schema.buildJobs).set({ cancelRequestedAt: new Date() }).where(eq(schema.buildJobs.buildId, buildId));
              controller.abort(); throw new Error("Cancelled after known effects");
            }
            await clean(input.cleanup);
            return { migrationDigest: scenario === "mismatch" ? "f".repeat(64) : migrationDigest, schemaDigest: "c".repeat(64), httpReady: true };
          },
          cleanup: async (_scope, _operation, _source, cleanup) => { await clean(cleanup); },
        });
        expect(outcome.status).toBe(scenario === "success" ? "success" : interrupted ? "interrupted" : "failed");
        const [saved] = await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, claim.id));
        const [validation] = await database.select().from(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.operationId, claim.id));
        expect(saved?.cleanupEffect?.kind ?? null).toBe((scenario === "artifact-cleanup-unknown" || scenario === "compilation-cleanup-unknown") ? "cleanup-validation-artifact" : null); expect(saved!.completedCleanupEffects.length).toBeGreaterThanOrEqual(3);
        expect(saved?.effect?.kind ?? null).toBe(scenario === "unknown" ? "apply-migrations" : (scenario === "preparation-unknown" || scenario === "compilation-cleanup-unknown") ? "prepare-validation-artifact" : null);
        if (scenario === "compilation-failed") {
          expect(outcome).toEqual({ status: "failed", diagnostics: "Type error: fixture component requires a title." });
          expect(saved?.completedEffects.map(effect => effect.kind)).toEqual(["failed-prepare-validation-artifact"]);
          expect(validation?.imageId).toBeNull();
          await expect(loadDatabaseValidation(database, claim)).rejects.toMatchObject({ status: 409 });
        }
        expect(validation?.schemaDigest).toBe(scenario === "success" ? "c".repeat(64) : null);
        expect(await hasDatabaseWork(database, project)).toBe(interrupted);
        const [resource] = await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
        expect(resource?.revision).toBe(revision); expect(resource?.status).toBe("ready"); expect(resource?.schemaDigest).toBeNull(); expect(resource?.runtimeIdentity).toBeNull();
        if (interrupted) {
          const review = { requestId: crypto.randomUUID(), operationId: claim.id, expectedRevision: revision };
          let recoveryCalls = 0;
          const recoveryCleanup: Parameters<typeof recoverDatabaseValidation>[4] = async (_scope, oldId, oldSource, cleanup) => {
            recoveryCalls++; expect(oldId).toBe(claim.id); expect(oldSource).toBe(resourceId); await clean(cleanup);
          };
          await expect(recoverDatabaseValidation(database, project, "db-viewer", review, recoveryCleanup)).rejects.toMatchObject({ status: 403 });
          await expect(recoverDatabaseValidation(database, project, "db-owner", review, recoveryCleanup)).rejects.toMatchObject({ status: 409 });
          expect(recoveryCalls).toBe(0);
          await database.update(schema.buildJobs).set({ status: "interrupted" }).where(eq(schema.buildJobs.buildId, buildId));
          await database.update(schema.builds).set({ status: "failed" }).where(eq(schema.builds.id, buildId));
          await expect(recoverDatabaseValidation(database, project, "db-owner", { ...review, expectedRevision: crypto.randomUUID() }, recoveryCleanup)).rejects.toMatchObject({ status: 409 });
          const failedReview = { ...review, requestId: crypto.randomUUID() };
          await expect(recoverDatabaseValidation(database, project, "db-owner", failedReview, async (_scope, _target, _source, cleanup) => {
            await cleanup.beforeCleanup("application", `wrenly-database-application-${claim.id}`); throw new Error("PRIVATE_FOREIGN_HELPER");
          })).rejects.toMatchObject({ status: 503 });
          expect(await hasDatabaseWork(database, project)).toBe(true);
          const recovered = await recoverDatabaseValidation(database, project, "db-owner", review, recoveryCleanup, artifactCleanup);
          expect(recovered.replayed).toBe(false);
          expect(await recoverDatabaseValidation(database, project, "db-owner", review, recoveryCleanup, artifactCleanup)).toEqual({ ...recovered, replayed: true });
          expect(recoveryCalls).toBe(1); expect(await hasDatabaseWork(database, project)).toBe(false);
          const [old] = await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, claim.id));
          expect(old?.status).toBe("failed"); expect(old?.effect?.kind ?? null).toBe(scenario === "unknown" ? "apply-migrations" : (scenario === "preparation-unknown" || scenario === "compilation-cleanup-unknown") ? "prepare-validation-artifact" : null);
          expect(old?.cleanupEffect?.kind ?? null).toBe((scenario === "artifact-cleanup-unknown" || scenario === "compilation-cleanup-unknown") ? "cleanup-validation-artifact" : null);
          const [afterRecovery] = await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
          expect(afterRecovery?.revision).toBe(revision); expect(afterRecovery?.status).toBe("ready");
        }
      } finally {
        await database.delete(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.buildId, buildId));
        await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.projectId, project));
        await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
        await database.delete(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId));
        await database.delete(schema.builds).where(eq(schema.builds.id, buildId));
        await database.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project));
        await database.delete(schema.projects).where(eq(schema.projects.id, project));
      }
    });
  for (const framework of ["nextjs", "laravel"] as const) for (const interrupted of [false, true]) test(`build database handoff uses saved actor/source and never retries unknown preparation (${framework}/${interrupted})`, async () => {
    const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID(), buildId = crypto.randomUUID(), token = crypto.randomUUID();
    const files = appDatabaseSource(framework), digest = readAppDatabaseManifest(files, framework)!.digest;
    const actor = framework === "laravel" ? "db-editor" : "db-owner";
    const parent = { projectId: project, buildId, token, input: { prompt: "Fixture", stack: framework, model: "fixture", provider: "fixture", previousFiles: [], previousErrors: [],
      databaseV1: { version: 1 as const, environment: "development" as const, resourceId, resourceRevision: revision } } };
    const selection = { operationId: crypto.randomUUID(), requestId: crypto.randomUUID(), resourceId, resourceRevision: revision, deadlineAt: Date.now() + 60_000 };
    const signal = new AbortController().signal;
    let preparationCalls = 0;
    const clean: NonNullable<Parameters<typeof recoverDatabaseValidation>[4]> = async (_scope, id, _source, cleanup) => {
      for (const kind of ["application", "socket", "database"] as const) {
        const name = kind === "database" ? `wrenly-database-${id}` : `wrenly-database-${kind}-${id}`;
        await cleanup.assertHeld(); await cleanup.beforeCleanup(kind, name); await cleanup.acknowledgeCleanup(kind, name);
      }
    };
    const cleanupArtifact = async (id: string, held: () => Promise<void>): Promise<void> => { expect(id).toBe(selection.operationId); await held(); };
    try {
      await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Build handoff", stack: framework, accessMode: "selected" });
      await database.insert(schema.projectMembers).values({ projectId: project, userId: "db-editor", role: "editor" });
      await database.insert(schema.builds).values({ id: buildId, projectId: project, prompt: "Fixture", stack: framework, status: "building", files });
      await database.insert(schema.buildJobs).values({ buildId, projectId: project, userId: actor, idempotencyKey: crypto.randomUUID(), requestIdentity: "fixture", status: "running", claimToken: token,
        leaseExpiresAt: new Date(Date.now() + 120_000), input: parent.input });
      await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision, createdBy: "db-owner",
        secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE" } });
      await expect(executeDatabaseBuildValidation(database, { ...parent, token: crypto.randomUUID() }, selection, signal)).rejects.toMatchObject({ status: 409 });
      await expect(executeDatabaseBuildValidation(database, parent, { ...selection, actorId: "db-owner", files }, signal)).rejects.toMatchObject({ status: 400 });
      await expect(executeDatabaseBuildValidation(database, parent, { ...selection, deadlineAt: Date.now() - 1 }, signal)).rejects.toMatchObject({ status: 409 });
      expect((await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.projectId, project))).length).toBe(0);
      const result = await executeDatabaseBuildValidation(database, parent, selection, signal, {
        prepare: async input => {
          preparationCalls++; await input.beforeEffect(); expect(input.files).toEqual(files); expect(input.migrationDigest).toBe(digest);
          const [saved] = await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, selection.operationId));
          expect(saved?.actorId).toBe(actor); expect(saved?.effect?.kind).toBe("prepare-validation-artifact");
          if (interrupted) throw new Error("PRIVATE_PREPARATION_UNKNOWN");
          return { imageId: `sha256:${"a".repeat(64)}`, baseImageId: `sha256:${"b".repeat(64)}`, sizeBytes: 1 };
        },
        validate: async input => {
          for (const kind of ["provision-roles", "apply-migrations", "enforce-policy", "inspect-schema", "create-container"] as const) {
            const effect = { kind, id: kind === "create-container" ? `wrenly-database-application-${selection.operationId}` : `fixture-${kind}` };
            await input.fence.beforeEffect(effect); await input.fence.acknowledgeEffect(effect);
          }
          await clean({ projectId: project, resourceId: selection.operationId, environment: "development" }, selection.operationId, resourceId, input.cleanup);
          return { migrationDigest: digest, schemaDigest: "c".repeat(64), httpReady: true };
        }, cleanup: clean, cleanupArtifact,
      });
      expect(result.operationId).toBe(selection.operationId); expect(result.outcome.status).toBe(interrupted ? "interrupted" : "success");
      await expect(executeDatabaseBuildValidation(database, parent, selection, signal)).rejects.toMatchObject({ status: 409 });
      expect(preparationCalls).toBe(1);
      if (interrupted) {
        await database.update(schema.buildJobs).set({ status: "interrupted" }).where(eq(schema.buildJobs.buildId, buildId));
        await database.update(schema.builds).set({ status: "failed" }).where(eq(schema.builds.id, buildId));
        await recoverDatabaseValidation(database, project, "db-owner", { operationId: selection.operationId, requestId: crypto.randomUUID(), expectedRevision: revision }, clean, cleanupArtifact);
      }
    } finally {
      await database.delete(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.buildId, buildId));
      await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.projectId, project));
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      await database.delete(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId));
      await database.delete(schema.builds).where(eq(schema.builds.id, buildId));
      await database.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  });
  for (const framework of ["nextjs", "laravel"] as const) test(`admission freezes explicit Development selection and retries cannot replace it (${framework})`, async () => {
    const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID();
    const choice = { version: 1 as const, environment: "development" as const, resourceId, resourceRevision: revision };
    const deps = { db: database, defaultModel: "fixture", resolveProvider: () => ({ id: "fixture" }) };
    const body = { projectId: project, prompt: "Build a booking app", stack: framework };
    const key = crypto.randomUUID();
    const settle = async (id: string): Promise<void> => {
      await database.update(schema.buildJobs).set({ status: "failed" }).where(eq(schema.buildJobs.buildId, id));
      await database.update(schema.builds).set({ status: "failed" }).where(eq(schema.builds.id, id));
    };
    try {
      await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Frozen choice", stack: framework });
      await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision, createdBy: "db-owner",
        secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE" } });
      await expect(admitBuild(body, "db-owner", crypto.randomUUID(), { ...deps, databaseSelection: { ...choice, resourceId: crypto.randomUUID() } })).rejects.toMatchObject({ status: 409 });
      expect((await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.projectId, project))).length).toBe(0);
      const admitted = await admitBuild(body, "db-owner", key, { ...deps, databaseSelection: choice });
      const [saved] = await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, admitted.buildId));
      expect(saved?.input.databaseV1).toEqual(choice); expect(JSON.stringify(saved?.input)).not.toContain("PRIVATE");
      expect(await admitBuild(body, "db-owner", key, { ...deps, databaseSelection: choice })).toEqual({ ...admitted, replayed: true });
      await expect(admitBuild(body, "db-owner", key, { ...deps, databaseSelection: { ...choice, resourceRevision: crypto.randomUUID() } })).rejects.toMatchObject({ status: 409 });
      await settle(admitted.buildId);
      await expect(admitBuild({ projectId: project, retryBuildId: admitted.buildId }, "db-owner", crypto.randomUUID(), { ...deps, databaseSelection: choice })).rejects.toMatchObject({ status: 400 });
      const retried = await admitBuild({ projectId: project, retryBuildId: admitted.buildId }, "db-owner", crypto.randomUUID(), deps);
      expect((await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, retried.buildId)))[0]?.input.databaseV1).toEqual(choice);
      await settle(retried.buildId);
      await database.update(schema.appDatabases).set({ revision: crypto.randomUUID() }).where(eq(schema.appDatabases.id, resourceId));
      await expect(admitBuild({ projectId: project, retryBuildId: admitted.buildId }, "db-owner", crypto.randomUUID(), deps)).rejects.toMatchObject({ status: 409 });
      expect((await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.projectId, project))).length).toBe(2);
      // Provisioning a resource does not silently turn all later builds into database requests.
      const stateless = await admitBuild({ ...body, prompt: "Change a static heading" }, "db-owner", crypto.randomUUID(), deps);
      expect((await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, stateless.buildId)))[0]?.input.databaseV1).toBeUndefined();
      await settle(stateless.buildId);
      const current = (await readDatabaseResources(database, project, "db-owner")).resources[0];
      if (!current) throw new Error("Missing current Development resource");
      const explicit = { ...body, database: { ...choice, resourceRevision: current.revision } };
      await expect(admitBuild(explicit, "db-owner", crypto.randomUUID(), deps)).rejects.toMatchObject({ status: 409 });
      const explicitKey = crypto.randomUUID();
      const direct = await admitBuild(explicit, "db-owner", explicitKey, { ...deps, allowDatabaseSelection: true });
      expect((await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, direct.buildId)))[0]?.input.databaseV1).toEqual(explicit.database);
      expect((await admitBuild(explicit, "db-owner", explicitKey, deps)).replayed).toBe(true);

    } finally {
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      await database.delete(schema.buildJobs).where(eq(schema.buildJobs.projectId, project));
      await database.delete(schema.builds).where(eq(schema.builds.projectId, project));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  });
  for (const framework of ["nextjs", "laravel"] as const) test(`ordinary conversation freezes Development choice into its atomic build (${framework})`, async () => {
    const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID();
    const choice = { version: 1 as const, environment: "development" as const, resourceId, resourceRevision: revision };
    const deps = { db: database, defaultModel: "fixture", resolveProvider: () => ({ id: "fixture" }) };
    try {
      await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Conversation database", stack: framework });
      await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision,
        createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE" } });
      const body = { message: "Plan a booking app", mode: "plan", database: choice };
      await expect(admitConversationTurn(project, "db-owner", crypto.randomUUID(), body, deps)).rejects.toMatchObject({ status: 409 });
      expect((await database.select().from(schema.conversations).where(eq(schema.conversations.projectId, project))).length).toBe(0);
      const admitted = await admitConversationTurn(project, "db-owner", crypto.randomUUID(), body, { ...deps, allowDatabaseSelection: true });
      const planned = await claimConversationTurn(database);
      if (!planned || planned.turnId !== admitted.turnId) throw new Error("Missing planned database turn");
      expect(planned.input.databaseV1).toEqual(choice);
      await expect(admitConversationBuildAction(database, planned, { type: "propose_build", content: "Build", prompt: "Build" }, deps)).rejects.toThrow("Plan mode");
      await completeConversationAnswer(database, planned, { type: "answer", content: "The booking plan is ready." });
      const key = crypto.randomUUID(), request = { message: "Build the booking app", mode: "auto", database: choice };
      const automatic = await admitConversationTurn(project, "db-owner", key, request, { ...deps, allowDatabaseSelection: true });
      expect((await admitConversationTurn(project, "db-owner", key, request, deps)).replayed).toBe(true);
      await expect(admitConversationTurn(project, "db-owner", key, { ...request, database: { ...choice, resourceRevision: crypto.randomUUID() } }, { ...deps, allowDatabaseSelection: true })).rejects.toMatchObject({ status: 409 });
      const claim = await claimConversationTurn(database);
      if (!claim || claim.turnId !== automatic.turnId) throw new Error("Missing automatic database turn");
      const proposal = { type: "propose_build", content: "I will build the booking app.", prompt: "Build the booking app" };
      await database.update(schema.appDatabases).set({ revision: crypto.randomUUID() }).where(eq(schema.appDatabases.id, resourceId));
      await expect(admitConversationBuildAction(database, claim, proposal, deps)).rejects.toMatchObject({ status: 409 });
      expect((await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.projectId, project))).length).toBe(0);
      await database.update(schema.appDatabases).set({ revision }).where(eq(schema.appDatabases.id, resourceId));
      const buildId = await admitConversationBuildAction(database, claim, proposal, deps);
      const [saved] = await database.select().from(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId));
      expect(saved?.input.databaseV1).toEqual(choice); expect(saved?.userId).toBe("db-owner");
      expect(JSON.stringify(saved?.input)).not.toContain("PRIVATE");
    } finally {
      await database.delete(schema.conversations).where(eq(schema.conversations.projectId, project));
      await database.delete(schema.buildJobs).where(eq(schema.buildJobs.projectId, project));
      await database.delete(schema.builds).where(eq(schema.builds.projectId, project));
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  });
  const runtimeValidationTest = process.env.WRENLY_TEST_APP_DATABASE_VALIDATION_RUNTIME === "true" ? test : test.skip;
  for (const framework of ["nextjs", "laravel"] as const) runtimeValidationTest(`saved ${framework} validation executes real migrations and CRUD through the durable executor`, async () => {
    const project = crypto.randomUUID(), resourceId = crypto.randomUUID(), revision = crypto.randomUUID(), buildId = crypto.randomUUID(), buildToken = crypto.randomUUID(), operationId = crypto.randomUUID();
    const files = databaseApplication(framework), migrationDigest = readAppDatabaseManifest(files, framework)!.digest;
    const deadline = Date.now() + 300_000, signal = AbortSignal.timeout(300_000);
    let currentClaim: Awaited<ReturnType<typeof beginDatabaseValidation>> | undefined;
    const command = async (args: string[]): Promise<{ code: number; output: string }> => {
      const child = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", ...args], { stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin" } });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try { const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]); return { code, output: output.trim() }; }
      finally { clearTimeout(timer); }
    };
    try {
      await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Real application validation", stack: framework });
      await database.insert(schema.builds).values({ id: buildId, projectId: project, prompt: "Fixture", stack: framework, status: "building", files });
      await database.insert(schema.buildJobs).values({ buildId, projectId: project, userId: "db-owner", idempotencyKey: crypto.randomUUID(), requestIdentity: "fixture", status: "running", claimToken: buildToken,
        leaseExpiresAt: new Date(deadline), input: { prompt: "Fixture", stack: framework, model: "fixture", provider: "fixture", previousFiles: [], previousErrors: [] } });
      await database.insert(schema.appDatabases).values({ id: resourceId, projectId: project, environment: "development", provider: "local", status: "ready", revision,
        createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "fixture", tag: "fixture", ciphertext: "PRIVATE" } });
      const claim = await beginDatabaseValidationPreparation(database, project, "db-owner", { operationId, requestId: crypto.randomUUID(), buildId, buildToken, resourceId, resourceRevision: revision,
        migrationDigest, remainingMs: deadline - Date.now() });
      currentClaim = claim;
      const outcome = await executeDatabaseValidation(database, claim, signal, {
        prepare: async input => {
          expect((await loadDatabaseValidation(database, claim)).imageId).toBeNull();
          return prepareDatabaseValidationArtifact({ ...input, beforeEffect: async () => {
            await input.beforeEffect();
            expect(await command(["ps", "-a", "--filter", `label=io.wrenly.database-id=${operationId}`, "--format", "{{.ID}}"])).toEqual({ code: 0, output: "" });
          } });
        },
      });
      expect(outcome.status).toBe("success");
      const [operation] = await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, operationId));
      const [validation] = await database.select().from(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.operationId, operationId));
      expect(operation?.status).toBe("success"); expect(operation?.effect).toBeNull(); expect(operation?.cleanupEffect).toBeNull();
      expect(validation?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(validation?.ownsArtifact).toBe(true);
      expect(validation?.imageId).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(operation?.completedCleanupEffects.some(effect => effect.kind === "cleanup-validation-artifact")).toBe(true);
      expect(await command(["image", "ls", "--filter", `label=io.wrenly.deployment-id=${operationId}`, "--format", "{{.ID}}"])).toEqual({ code: 0, output: "" });
      expect(await hasDatabaseWork(database, project)).toBe(false);
      for (const category of ["container", "volume", "network"]) {
        const args = category === "container" ? ["ps", "-a"] : [category, "ls"];
        expect(await command([...args, "--filter", `label=io.wrenly.database-id=${operationId}`, "--format", category === "container" ? "{{.ID}}" : "{{.Name}}"])).toEqual({ code: 0, output: "" });
      }
      const [resource] = await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      expect(resource?.revision).toBe(revision); expect(resource?.schemaDigest).toBeNull(); expect(resource?.runtimeIdentity).toBeNull();
    } finally {
      const [unfinished] = await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, operationId));
      if (unfinished && ["running", "interrupted"].includes(unfinished.status)) {
        if (unfinished.status === "running" && currentClaim) await interruptDatabaseAction(database, currentClaim);
        await database.update(schema.buildJobs).set({ status: "interrupted" }).where(eq(schema.buildJobs.buildId, buildId));
        await database.update(schema.builds).set({ status: "failed" }).where(eq(schema.builds.id, buildId));
        await recoverDatabaseValidation(database, project, "db-owner", { operationId, requestId: crypto.randomUUID(), expectedRevision: revision });
      }
      await cleanupRuntimeArtifactPreparation(operationId);
      await database.delete(schema.appDatabaseValidations).where(eq(schema.appDatabaseValidations.buildId, buildId));
      await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.projectId, project));
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.id, resourceId));
      await database.delete(schema.buildJobs).where(eq(schema.buildJobs.buildId, buildId));
      await database.delete(schema.builds).where(eq(schema.builds.id, buildId));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  }, 320_000);
  test("owner, Editor, Viewer and unrelated instance administrator remain distinct", async () => {
    expect(
      (await readDatabaseResources(database, projectId, "db-owner"))
        .capabilities,
    ).toEqual({ manage: true, developmentRows: true, productionRows: true });
    expect(
      (await readDatabaseResources(database, projectId, "db-editor"))
        .capabilities,
    ).toEqual({ manage: false, developmentRows: true, productionRows: false });
    expect(
      (await readDatabaseResources(database, projectId, "db-viewer"))
        .capabilities,
    ).toEqual({ manage: false, developmentRows: false, productionRows: false });
    for (const actor of ["db-admin", "db-outsider"])
      await expect(
        readDatabaseResources(database, projectId, actor),
      ).rejects.toMatchObject({ status: 404 });
    for (const actor of ["db-editor", "db-viewer"])
      await expect(
        admitDatabaseAction(database, projectId, actor, create(), directory),
      ).rejects.toMatchObject({ status: 403 });
  });
  test("viewer authority binds exact environment/revision and exposes no stored credentials", async () => {
    const project = crypto.randomUUID(), development = crypto.randomUUID(), production = crypto.randomUUID();
    const revision = crypto.randomUUID();
    await database.insert(schema.projects).values({ id: project, userId: "db-owner", name: "Viewer authority fixture", accessMode: "selected" });
    await database.insert(schema.projectMembers).values([
      { projectId: project, userId: "db-editor", role: "editor" },
      { projectId: project, userId: "db-viewer", role: "viewer" },
    ]);
    try {
      // Deliberately undecryptable: schema authority must not load keys or parse secrets.
      await database.insert(schema.appDatabases).values([
        { id: development, projectId: project, environment: "development", provider: "local", status: "ready", revision,
          createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "", tag: "", ciphertext: "never projected" } },
        { id: production, projectId: project, environment: "production", provider: "fixture", status: "ready", revision,
          createdBy: "db-owner", secrets: { version: 1, keyId: "fixture", nonce: "", tag: "", ciphertext: "never projected" } },
      ]);
      const input = { resourceId: development, revision, environment: "development" as const, rows: true, table: "notes" };
      const visible = await readDatabaseViewAuthority(database, project, "db-editor", input);
      expect(Object.keys(visible).sort()).toEqual(["accessRevision", "resourceId", "resourceRevision"]);
      await expect(readDatabaseViewAuthority(database, project, "db-viewer", input)).rejects.toMatchObject({ status: 403 });
      expect((await readDatabaseViewAuthority(database, project, "db-viewer", { ...input, rows: false })).resourceId).toBe(development);
      await expect(readDatabaseViewAuthority(database, project, "db-admin", input)).rejects.toMatchObject({ status: 404 });
      const prod = { ...input, resourceId: production, environment: "production" as const };
      await expect(readDatabaseViewAuthority(database, project, "db-editor", prod)).rejects.toMatchObject({ status: 403 });
      expect((await readDatabaseViewAuthority(database, project, "db-owner", prod)).resourceId).toBe(production);
      await expect(readDatabaseViewAuthority(database, project, "db-owner", { ...input, environment: "production" })).rejects.toMatchObject({ status: 404 });
      const nextAccess = crypto.randomUUID();
      await database.update(schema.projects).set({ accessRevision: nextAccess }).where(eq(schema.projects.id, project));
      expect((await readDatabaseViewAuthority(database, project, "db-editor", input)).accessRevision).toBe(nextAccess);
      const claim = await beginDatabaseRead(database, project, "db-editor", input);
      await assertDatabaseRead(database, claim);
      expect(await hasDatabaseWork(database, project)).toBe(true);
      await expect(beginDatabaseRead(database, project, "db-viewer", { ...input, rows: false })).rejects.toMatchObject({ status: 409 });
      await database.update(schema.projects).set({ accessRevision: crypto.randomUUID() }).where(eq(schema.projects.id, project));
      await expect(assertDatabaseRead(database, claim)).rejects.toMatchObject({ status: 409 });
      await finishDatabaseRead(database, claim, false);
      expect(await hasDatabaseWork(database, project)).toBe(false);
      const next = await beginDatabaseRead(database, project, "db-viewer", { ...input, rows: false });
      const socketId = `wrenly-database-socket-${next.id}`;
      await recordDatabaseEffect(database, next, { kind: "create-socket", id: socketId });
      await acknowledgeDatabaseEffect(database, next, socketId);
      await expect(finishDatabaseRead(database, next, true)).rejects.toMatchObject({ status: 409 });
      await recordDatabaseCleanupEffect(database, next, { kind: "close-reader-socket", id: socketId });
      await acknowledgeDatabaseCleanupEffect(database, next, socketId);
      await finishDatabaseRead(database, next, true);
      expect(await hasDatabaseWork(database, project)).toBe(false);
      await database.update(schema.appDatabases).set({ revision: crypto.randomUUID() }).where(eq(schema.appDatabases.id, development));
      await expect(readDatabaseViewAuthority(database, project, "db-editor", input)).rejects.toMatchObject({ status: 409 });
    } finally {
      await database.delete(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.projectId, project));
      await database.delete(schema.appDatabases).where(eq(schema.appDatabases.projectId, project));
      await database.delete(schema.projectMembers).where(eq(schema.projectMembers.projectId, project));
      await database.delete(schema.projects).where(eq(schema.projects.id, project));
    }
  });
  test("exact replay returns one encrypted resource and credentials are never projected", async () => {
    const input = create();
    const result = await admitDatabaseAction(
      database,
      projectId,
      "db-owner",
      input,
      directory,
    );
    const replay = await admitDatabaseAction(
      database,
      projectId,
      "db-owner",
      input,
      directory,
    );
    expect(replay).toEqual({ ...result, replayed: true });
    expect(await hasDatabaseWork(database, projectId)).toBe(true);
    await expect(
      admitDatabaseAction(
        database,
        projectId,
        "db-owner",
        { ...input, environment: "production" },
        directory,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const snapshot = await readDatabaseResources(
      database,
      projectId,
      "db-owner",
    );
    expect(snapshot.resources).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("ciphertext");
    expect(JSON.stringify(snapshot)).not.toContain("password");
    expect(JSON.stringify(snapshot)).not.toContain("claimToken");
    const statusHandler = createDatabaseResourceStatusHandler({ userId: async () => "db-owner",
      read: (project, actor) => readDatabaseResources(database, project, actor) });
    const statusResponse = await statusHandler(new Request(`http://localhost/api/projects/${projectId}/databases`), projectId);
    expect(statusResponse.status).toBe(200);
    const publicStatus = DatabaseResourceStatus.parse(await statusResponse.json());
    expect(publicStatus.resources[0]?.id).toBe(result.resourceId);
    expect(publicStatus.operations[0]?.status).toBe("queued");
    const actionHandlers = createDatabaseActionHandlers({ userId: async () => "db-owner",
      admit: (project, actor, body) => admitDatabaseAction(database, project, actor, body, directory),
      lookup: (project, actor, key) => readDatabaseActionAcknowledgement(database, project, actor, key),
    }, "http://localhost:3000");
    const actionUrl = `http://localhost/api/projects/${projectId}/database-actions`;
    const replayResponse = await actionHandlers.submit(new Request(actionUrl, { method: "POST",
      headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(input) }), projectId);
    expect(replayResponse.status).toBe(200);
    expect(await replayResponse.json()).toEqual({ ...result, replayed: true });
    const acknowledged = await actionHandlers.acknowledgement(new Request(actionUrl), projectId, input.requestId);
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toEqual({ acknowledgement: { ...result, replayed: true } });
    await expect(readDatabaseActionAcknowledgement(database, projectId, "db-editor", input.requestId)).rejects.toMatchObject({ status: 403 });
    expect(await readDatabaseActionAcknowledgement(database, projectId, "db-owner", crypto.randomUUID())).toBeNull();
    const claim = await claimDatabaseAction(database);
    expect(claim).not.toBeNull();
    if (!claim) throw new Error("Missing claim");
    expect(await claimDatabaseAction(database)).toBeNull();
    const execution = await loadDatabaseExecution(database, claim, directory);
    expect(execution.credentials.runtime.user).toContain(
      claim.resourceId.replaceAll("-", ""),
    );
    await expect(
      finishDatabaseAction(database, claim, { success: true }),
    ).rejects.toMatchObject({ status: 409 });
    await recordDatabaseEffect(database, claim, {
      kind: "create-container",
      id: "fixture-container",
    });
    await expect(
      recordDatabaseEffect(database, claim, { kind: "start", id: "duplicate" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      finishDatabaseAction(database, claim, {
        success: false,
        errorCode: "VERIFIED_OPERATION_FAILED",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await acknowledgeDatabaseEffect(database, claim, "fixture-container", {
      version: 1,
      containerId: "fixture-container",
      volumeName: "fixture-volume",
      networkId: "fixture-network",
      imageId: "fixture-image",
    });
    await expect(
      finishDatabaseAction(database, claim, { success: true }),
    ).rejects.toMatchObject({ status: 409 });
    await recordDatabaseEffect(database, claim, {
      kind: "provision-roles",
      id: "fixture-roles",
    });
    await acknowledgeDatabaseEffect(database, claim, "fixture-roles");
    await finishDatabaseAction(database, claim, { success: true });
    await expect(renewDatabaseAction(database, claim)).rejects.toMatchObject({
      status: 409,
    });
    expect(await hasDatabaseWork(database, projectId)).toBe(false);
    expect(
      (await readDatabaseResources(database, projectId, "db-owner"))
        .resources[0]?.status,
    ).toBe("ready");
    expect(
      (
        await admitDatabaseAction(
          database,
          projectId,
          "db-owner",
          input,
          directory,
        )
      ).operationId,
    ).toBe(result.operationId);
  });
  test("stale revisions and invalid transitions cannot admit new effects", async () => {
    const [resource] = (
      await readDatabaseResources(database, projectId, "db-owner")
    ).resources;
    if (!resource) throw new Error("Missing resource");
    await expect(
      admitDatabaseAction(
        database,
        projectId,
        "db-owner",
        { ...create(), kind: "stop", expectedRevision: crypto.randomUUID() },
        directory,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      admitDatabaseAction(
        database,
        projectId,
        "db-owner",
        { ...create(), kind: "start", expectedRevision: resource.revision },
        directory,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      admitDatabaseAction(
        database,
        projectId,
        "db-owner",
        { ...create(), kind: "migrate", expectedRevision: resource.revision },
        directory,
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("expired claims cannot revive or mutate and crash recovery retains unresolved effects", async () => {
    const [resource] = (
      await readDatabaseResources(database, projectId, "db-owner")
    ).resources;
    if (!resource) throw new Error("Missing resource");
    await admitDatabaseAction(
      database,
      projectId,
      "db-owner",
      { ...create(), kind: "stop", expectedRevision: resource.revision },
      directory,
    );
    const claim = await claimDatabaseAction(database);
    if (!claim) throw new Error("Missing claim");
    await recordDatabaseEffect(database, claim, {
      kind: "stop",
      id: "uncertain-stop",
    });
    await database
      .update(schema.appDatabaseOperations)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.appDatabaseOperations.id, claim.id));
    await expect(renewDatabaseAction(database, claim)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      loadDatabaseExecution(database, claim, directory),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      acknowledgeDatabaseEffect(database, claim, "uncertain-stop"),
    ).rejects.toMatchObject({ status: 409 });
    await interruptExpiredDatabaseActions(database);
    const [operation] = await database
      .select()
      .from(schema.appDatabaseOperations)
      .where(eq(schema.appDatabaseOperations.id, claim.id));
    expect(operation?.status).toBe("interrupted");
    expect(operation?.effect?.id).toBe("uncertain-stop");
    expect(operation?.claimToken).toBeNull();
    expect(
      (await readDatabaseResources(database, projectId, "db-owner"))
        .resources[0]?.status,
    ).toBe("recovery_required");
    expect(await hasDatabaseWork(database, projectId)).toBe(true);
    expect(await claimDatabaseAction(database)).toBeNull();
    await expect(
      admitDatabaseAction(
        database,
        projectId,
        "db-owner",
        { ...create(), kind: "stop", expectedRevision: resource.revision },
        directory,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("an interrupted project does not starve another project; concurrent admission creates one resource", async () => {
    const otherProject = crypto.randomUUID();
    await database.insert(schema.projects).values({
      id: otherProject,
      userId: "db-owner",
      name: "Independent fixture",
    });
    const actions = await Promise.allSettled(
      [create(), create()].map((input) =>
        admitDatabaseAction(
          database,
          otherProject,
          "db-owner",
          input,
          directory,
        ),
      ),
    );
    expect(
      actions.filter((action) => action.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (await readDatabaseResources(database, otherProject, "db-owner"))
        .resources,
    ).toHaveLength(1);
    const claim = await claimDatabaseAction(database);
    expect(claim?.projectId).toBe(otherProject);
    if (!claim) throw new Error("Missing independent claim");
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, "db-owner"));
    await expect(
      loadDatabaseExecution(database, claim, directory),
    ).rejects.toMatchObject({ status: 409 });
    await database
      .update(schema.user)
      .set({ banned: false })
      .where(eq(schema.user.id, "db-owner"));
    await finishDatabaseAction(database, claim, {
      success: false,
      errorCode: "PREREQUISITE_UNAVAILABLE",
    });
    const failed = (
      await readDatabaseResources(database, otherProject, "db-owner")
    ).resources[0];
    expect(failed?.status).toBe("failed");
    if (!failed) throw new Error("Missing failed resource");
    const retry = await admitDatabaseAction(
      database,
      otherProject,
      "db-owner",
      { ...create(), expectedRevision: failed.revision },
      directory,
    );
    expect(retry.resourceId).toBe(claim.resourceId);
    expect(
      (await readDatabaseResources(database, otherProject, "db-owner"))
        .resources,
    ).toHaveLength(1);
  });
  test("revoked queued owner is failed before execution and does not starve the next project", async () => {
    await database
      .update(schema.appDatabaseOperations)
      .set({
        status: "failed",
        errorCode: "FIXTURE_FINISHED",
        completedAt: new Date(),
      })
      .where(eq(schema.appDatabaseOperations.status, "queued"));
    const project = crypto.randomUUID();
    await database.insert(schema.projects).values({
      id: project,
      userId: "db-owner",
      name: "Revoked queue fixture",
    });
    const action = await admitDatabaseAction(
      database,
      project,
      "db-owner",
      create(),
      directory,
    );
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, "db-owner"));
    expect(await claimDatabaseAction(database)).toBeNull();
    const [operation] = await database
      .select()
      .from(schema.appDatabaseOperations)
      .where(eq(schema.appDatabaseOperations.id, action.operationId));
    expect(operation?.status).toBe("failed");
    expect(operation?.errorCode).toBe("ACTOR_ACCESS_CHANGED");
    expect(operation?.effect).toBeNull();
    await database
      .update(schema.user)
      .set({ banned: false })
      .where(eq(schema.user.id, "db-owner"));
    const [resource] = (
      await readDatabaseResources(database, project, "db-owner")
    ).resources;
    expect(
      (
        await admitDatabaseAction(
          database,
          project,
          "db-owner",
          { ...create(), expectedRevision: resource!.revision },
          directory,
        )
      ).resourceId,
    ).toBe(action.resourceId);
  });
  test("explicit effect-free recovery is owned, revision-bound, audited and exactly replayable", async () => {
    await database
      .update(schema.appDatabaseOperations)
      .set({ status: "failed", errorCode: "FIXTURE_FINISHED" })
      .where(eq(schema.appDatabaseOperations.status, "queued"));
    const project = crypto.randomUUID();
    await database.insert(schema.projects).values({
      id: project,
      userId: "db-owner",
      name: "Recovery fixture",
      accessMode: "selected",
    });
    await database
      .insert(schema.projectMembers)
      .values({ projectId: project, userId: "db-editor", role: "editor" });
    const admitted = await admitDatabaseAction(
      database,
      project,
      "db-owner",
      create(),
      directory,
    );
    const claim = await claimDatabaseAction(database);
    if (!claim || claim.id !== admitted.operationId)
      throw new Error("Missing recovery claim");
    await interruptDatabaseAction(database, claim);
    const resource = (
      await readDatabaseResources(database, project, "db-owner")
    ).resources[0];
    if (!resource) throw new Error("Missing recovery resource");
    const recoveryReview = await readDatabaseRecoveryReview(database, project, "db-owner", resource.id, claim.id);
    expect(recoveryReview.choices).toEqual(["recover-before-effect"]);
    expect(recoveryReview.revision).toBe(resource.revision);
    await expect(readDatabaseRecoveryReview(database, project, "db-editor", resource.id, claim.id)).rejects.toMatchObject({ status: 403 });

    const action = {
      requestId: crypto.randomUUID(),
      operationId: claim.id,
      expectedRevision: resource.revision,
    };
    await expect(
      recoverUnstartedDatabaseAction(database, project, "db-editor", action),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      recoverUnstartedDatabaseAction(database, project, "db-owner", {
        ...action,
        expectedRevision: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    let recoveryActor = "db-editor";
    const recoveryHandlers = createDatabaseRecoveryHandlers({
      userId: async () => recoveryActor,
      admit: (id, actor, value) => admitDatabaseRecovery(database, id, actor, value),
      lookup: (id, actor, requestId) => readDatabaseActionAcknowledgement(database, id, actor, requestId),
    }, "http://localhost:3000");
    const recoveryRequest = (): Request => new Request("http://localhost/database-recovery", {
      method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ ...action, kind: "recover-before-effect", confirmRecovery: true }),
    });
    expect((await recoveryHandlers.submit(recoveryRequest(), project)).status).toBe(403);
    recoveryActor = "db-owner";
    const recoveryResponse = await recoveryHandlers.submit(recoveryRequest(), project);
    expect(recoveryResponse.status).toBe(202);
    const recovered = DatabaseActionAcknowledgement.parse(await recoveryResponse.json());
    expect((await recoveryHandlers.submit(recoveryRequest(), project)).status).toBe(200);
    const savedRecovery = await recoveryHandlers.acknowledgement(new Request("http://localhost/"), project, action.requestId);
    expect(await savedRecovery.json()).toEqual({ acknowledgement: { ...recovered, replayed: true } });
    expect(recovered.replayed).toBe(false);
    expect(await hasDatabaseWork(database, project)).toBe(false);
    expect(
      await recoverUnstartedDatabaseAction(
        database,
        project,
        "db-owner",
        action,
      ),
    ).toEqual({ ...recovered, replayed: true });
    await expect(
      recoverUnstartedDatabaseAction(database, project, "db-owner", {
        ...action,
        expectedRevision: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const current = (await readDatabaseResources(database, project, "db-owner"))
      .resources[0];
    const held = await acquireDatabaseExecutorLock({
      id: claim.id,
      resourceId: claim.resourceId,
      projectId: project,
      token: crypto.randomUUID(),
    });
    try {
      expect(
        await recoverUnstartedDatabaseAction(
          database,
          project,
          "db-owner",
          action,
        ),
      ).toEqual({ ...recovered, replayed: true });
      await expect(
        recoverUnstartedDatabaseAction(database, project, "db-owner", {
          ...action,
          requestId: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      await held.release();
    }
    expect(current?.status).toBe("failed");
    if (!current) throw new Error("Missing recovered resource");
    const retry = await admitDatabaseAction(
      database,
      project,
      "db-owner",
      { ...create(), expectedRevision: current.revision },
      directory,
    );
    expect(retry.resourceId).toBe(resource.id);
    const next = await claimDatabaseAction(database);
    if (!next) throw new Error("Missing retry claim");
    await recordDatabaseEffect(database, next, {
      kind: "create-volume",
      id: "unknown-volume",
    });
    await interruptDatabaseAction(database, next);
    const uncertain = (
      await readDatabaseResources(database, project, "db-owner")
    ).resources[0];
    await expect(
      recoverUnstartedDatabaseAction(database, project, "db-owner", {
        requestId: crypto.randomUUID(),
        operationId: next.id,
        expectedRevision: uncertain!.revision,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await hasDatabaseWork(database, project)).toBe(true);
  });
  const workerTest =
    process.env.WRENLY_TEST_APP_DATABASE_WORKER === "true" ? test : test.skip;
  workerTest.each(["nextjs", "laravel"] as const)(
    process.env.WRENLY_TEST_DATABASE_COMBINED_RUNTIME === "true"
      ? "joined Development validation, reviewed migration and live preview (%s)"
      : "production executor creates roles and persists stop/start independently of a browser (%s)",
    async (framework) => {
      const workerProject = crypto.randomUUID();
      await database.insert(schema.projects).values({
        id: workerProject,
        userId: "db-owner",
        name: "Worker fixture",
        stack: framework,
      });
      // The preceding metadata-only fixture leaves a queued explicit retry. It is
      // not a Docker acceptance request and must not be picked up by this worker.
      await database
        .update(schema.appDatabaseOperations)
        .set({
          status: "failed",
          errorCode: "FIXTURE_FINISHED",
          completedAt: new Date(),
        })
        .where(eq(schema.appDatabaseOperations.status, "queued"));
      const admitted = await admitDatabaseAction(
        database,
        workerProject,
        "db-owner",
        create(),
        directory,
      );
      const worker = createProductionDatabaseWorker(database, directory);
      const admitWhileWorkerRuns = async (
        body: unknown,
      ): Promise<{
        operationId: string;
        resourceId: string;
        replayed: boolean;
      }> => {
        const deadline = Date.now() + 3000;
        while (true) {
          try {
            return await admitDatabaseAction(
              database,
              workerProject,
              "db-owner",
              body,
              directory,
            );
          } catch (error) {
            if (
              !(
                error &&
                typeof error === "object" &&
                "status" in error &&
                error.status === 503
              ) ||
              Date.now() >= deadline
            )
              throw error;
            // NOWAIT coordination or a lost response may be retried only with the
            // exact frozen UUID/body; the unique action record prevents reexecution.
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
          }
        }
      };
      const waitFor = async (operationId: string): Promise<void> => {
        const deadline = Date.now() + (framework === "laravel" ? 240_000 : 60_000);
        while (Date.now() < deadline) {
          const [operation] = await database
            .select()
            .from(schema.appDatabaseOperations)
            .where(eq(schema.appDatabaseOperations.id, operationId));
          if (operation?.status === "success") return;
          if (
            operation?.status === "failed" ||
            operation?.status === "interrupted"
          )
            throw new Error(
              `Database worker fixture ended: ${operation.status}/${operation.errorCode}`,
            );
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("Database worker fixture timed out");
      };
      const dockerCommand = async (args: string[]): Promise<string> => {
        const child = Bun.spawn(
          ["docker", "--host", "unix:///var/run/docker.sock", ...args],
          { stdout: "pipe", stderr: "pipe" },
        );
        const [code, output, error] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`Fixture cleanup failed: ${error}`);
        return output;
      };
      try {
        await waitFor(admitted.operationId);
        const [ready] = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources;
        expect(ready?.status).toBe("ready");
        if (!ready) throw new Error("Missing ready resource");
        const [operation] = await database
          .select()
          .from(schema.appDatabaseOperations)
          .where(eq(schema.appDatabaseOperations.id, admitted.operationId));
        expect(
          operation?.completedEffects.some(
            (effect) => effect.kind === "provision-roles",
          ),
        ).toBe(true);
        const [initialSource] = await database
          .select()
          .from(schema.appDatabases)
          .where(eq(schema.appDatabases.id, ready.id));
        const backup = await admitWhileWorkerRuns({
          ...create(),
          kind: "backup",
          expectedRevision: ready.revision,
        });
        await waitFor(backup.operationId);
        const [verifiedBackup] = await database
          .select()
          .from(schema.appDatabaseBackups)
          .where(eq(schema.appDatabaseBackups.operationId, backup.operationId));
        expect(verifiedBackup?.verifiedAt).not.toBeNull();
        expect(verifiedBackup?.sha256).toMatch(/^[a-f0-9]{64}$/);
        const [afterBackup] = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources;
        if (!afterBackup) throw new Error("Missing post-backup resource");
        const [savedSource] = await database
          .select()
          .from(schema.appDatabases)
          .where(eq(schema.appDatabases.id, ready.id));
        expect(savedSource?.runtimeIdentity).toEqual(
          initialSource?.runtimeIdentity,
        );
        if (!verifiedBackup)
          throw new Error("Missing verified migration backup");
        let migrationFiles = [
          {
            path: "wrenly.app.json",
            content: JSON.stringify({
              version: 1,
              database: {
                engine: "postgresql",
                adapter: "drizzle-postgres",
                migrations: ["drizzle/0000_notes.sql"],
              },
            }),
          },
          {
            path: "drizzle/0000_notes.sql",
            content: "CREATE TABLE notes (id serial PRIMARY KEY, body text);\n--> statement-breakpoint\nINSERT INTO notes(body) VALUES ('Shared reader fixture');",
          },
          {
            path: "drizzle/meta/_journal.json",
            content: JSON.stringify({
              version: "7",
              dialect: "postgresql",
              entries: [
                {
                  idx: 0,
                  version: "7",
                  when: 1,
                  tag: "0000_notes",
                  breakpoints: true,
                },
              ],
            }),
          },
        ];
        if (framework === "laravel") {
          const path = "database/migrations/2026_10_23_000000_create_notes.php";
          migrationFiles = [...laravelFixture(), { path, content: `<?php
            use Illuminate\\Database\\Migrations\\Migration;
            use Illuminate\\Database\\Schema\\Blueprint;
            use Illuminate\\Support\\Facades\\Schema;
            return new class extends Migration {
              public function up(): void { Schema::create('notes', function (Blueprint $table) {
                $table->id(); $table->text('body')->nullable();
              }); \\Illuminate\\Support\\Facades\\DB::table('notes')->insert(['body' => 'Shared reader fixture']); }
            };` }, { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
              engine: "postgresql", adapter: "laravel", migrations: [path],
            } }) }];
        }
        const combined = process.env.WRENLY_TEST_DATABASE_COMBINED_RUNTIME === "true";
        if (combined) migrationFiles = databasePreviewApplication(framework);
        const migrationSet = readAppDatabaseManifest(migrationFiles, framework);
        if (!migrationSet) throw new Error("Missing migration manifest");
        const buildId = crypto.randomUUID();
        await database.insert(schema.builds).values({
          id: buildId,
          projectId: workerProject,
          prompt: "Migration fixture",
          status: "success",
          stack: framework,
          files: migrationFiles,
        });
        if (combined) await validatePreviewBuild(database, { projectId: workerProject, buildId, framework, resourceId: ready.id, revision: afterBackup.revision });
        const migrationAction = {
          requestId: crypto.randomUUID(),
          kind: "migrate",
          environment: "development",
          expectedRevision: afterBackup.revision,
          buildId,
          backupId: verifiedBackup.id,
          migrationDigest: migrationSet.digest,
          confirmChanges: true,
        };
        await expect(
          admitDatabaseAction(
            database,
            workerProject,
            "db-editor",
            migrationAction,
            directory,
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          admitDatabaseAction(
            database,
            workerProject,
            "db-owner",
            { ...migrationAction, migrationDigest: "f".repeat(64) },
            directory,
          ),
        ).rejects.toMatchObject({ status: 409 });
        const migration = await admitWhileWorkerRuns(migrationAction);
        await waitFor(migration.operationId);
        const replayedMigration = await admitWhileWorkerRuns(migrationAction);
        expect(replayedMigration).toMatchObject({
          operationId: migration.operationId,
          replayed: true,
        });
        const [review] = await database
          .select()
          .from(schema.appDatabaseMigrations)
          .where(
            eq(schema.appDatabaseMigrations.operationId, migration.operationId),
          );
        expect(review?.backupId).toBe(verifiedBackup.id);
        expect(review?.completedAt).not.toBeNull();
        const [migrated] = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources;
        expect(migrated?.schemaDigest).toBe(review?.rehearsedSchemaDigest);
        if (!migrated) throw new Error("Missing migrated database");
        const [migrationOperation] = await database
          .select()
          .from(schema.appDatabaseOperations)
          .where(eq(schema.appDatabaseOperations.id, migration.operationId));
        expect(migrationOperation?.effect).toBeNull();
        expect(migrationOperation?.cleanupEffect).toBeNull();
        expect(
          migrationOperation?.completedCleanupEffects.some(
            (effect) => effect.kind === "terminate-sessions",
          ),
        ).toBe(true);
        if (combined) {
          await verifyLiveDatabasePreview(database, { projectId: workerProject, buildId, directory });
          // The separate native resource cases cover stop/start, viewer roles and interruption recovery.
          return;
        }
        const stopped = await admitWhileWorkerRuns({
          ...create(),
          kind: "stop",
          expectedRevision: migrated.revision,
        });
        await waitFor(stopped.operationId);
        const [snapshot] = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources;
        expect(snapshot?.status).toBe("stopped");
        const started = await admitWhileWorkerRuns({
          ...create(),
          kind: "start",
          expectedRevision: snapshot!.revision,
        });
        await waitFor(started.operationId);
        expect(
          (await readDatabaseResources(database, workerProject, "db-owner"))
            .resources[0]?.status,
        ).toBe("ready");
        await worker.stop();
        await database.update(schema.projects).set({ accessMode: "selected" }).where(eq(schema.projects.id, workerProject));
        await database.insert(schema.projectMembers).values([
          { projectId: workerProject, userId: "db-editor", role: "editor" },
          { projectId: workerProject, userId: "db-viewer", role: "viewer" },
        ]);
        const services = {
          authority: (project: string, actor: string, input: Parameters<typeof readDatabaseViewAuthority>[3]) => readDatabaseViewAuthority(database, project, actor, input),
          query: (project: string, actor: string, input: Parameters<typeof readDatabaseViewAuthority>[3], signal: AbortSignal) => runDatabaseViewQuery(database, directory, project, actor, input, signal),
        };
        const readyForRead = (await readDatabaseResources(database, workerProject, "db-owner")).resources[0]!;
        const viewInput = { resourceId: readyForRead.id, revision: readyForRead.revision, environment: "development", table: "notes", rows: true };
        const rows = await readAuthorizedDatabaseView(services, workerProject, "db-editor", viewInput, AbortSignal.timeout(60_000));
        expect(rows.rows).toEqual([["1", "Shared reader fixture"]]);
        const schemaView = await readAuthorizedDatabaseView(services, workerProject, "db-viewer", { ...viewInput, rows: false }, AbortSignal.timeout(60_000));
        expect(schemaView.rows).toEqual([]);
        expect(schemaView.columns.map(column => column.name)).toEqual(["id", "body"]);
        expect(await hasDatabaseWork(database, workerProject)).toBe(false);
        const abandonedRead = await beginDatabaseRead(database, workerProject, "db-editor", viewInput);
        await interruptDatabaseAction(database, abandonedRead);
        const recoveryResource = (await readDatabaseResources(database, workerProject, "db-owner")).resources[0]!;
        const recoveryRequest = { requestId: crypto.randomUUID(), operationId: abandonedRead.id, expectedRevision: recoveryResource.revision };
        await recoverUnstartedDatabaseAction(database, workerProject, "db-owner", recoveryRequest);
        expect((await recoverUnstartedDatabaseAction(database, workerProject, "db-owner", recoveryRequest)).replayed).toBe(true);
        expect(await hasDatabaseWork(database, workerProject)).toBe(false);
        const beforeLostRead = (await readDatabaseResources(database, workerProject, "db-owner")).resources[0]!;
        const lostRead = await beginDatabaseRead(database, workerProject, "db-editor", { ...viewInput, revision: beforeLostRead.revision });
        const readLock = await acquireDatabaseExecutorLock(lostRead);
        try {
          const connection = await loadDatabaseReadConnection(database, lostRead, directory);
          await startDatabaseSocket({ scope: { resourceId: lostRead.resourceId, projectId: workerProject, environment: "development" },
            database: connection.identity, socketId: lostRead.id, role: { kind: "reader", ...connection.role },
            fence: { assertHeld: async () => { readLock.assertHeld(); await assertDatabaseRead(database, lostRead); },
              beforeEffect: effect => recordDatabaseEffect(database, lostRead, effect),
              acknowledgeEffect: effect => acknowledgeDatabaseEffect(database, lostRead, effect.id) }, signal: AbortSignal.timeout(20_000) });
          await recordDatabaseEffect(database, lostRead, { kind: "read-database", id: `wrenly-database-query-${lostRead.id}` });
          await interruptDatabaseAction(database, lostRead);
        } finally { await readLock.release(); }
        const reviewRead = { requestId: crypto.randomUUID(), operationId: lostRead.id,
          expectedRevision: (await readDatabaseResources(database, workerProject, "db-owner")).resources[0]!.revision };
        await expect(recoverDatabaseRead(database, workerProject, "db-editor", reviewRead)).rejects.toMatchObject({ status: 403 });
        await expect(recoverDatabaseRead(database, workerProject, "db-owner", { ...reviewRead, operationId: migration.operationId })).rejects.toMatchObject({ status: 409 });
        const foreignName = `wrenly-database-query-${lostRead.id}`;
        await dockerCommand(["create", "--name", foreignName, "--network=none", "--label", "io.wrenly.role=foreign-fixture", "oven/bun:alpine", "true"]);
        try {
          await expect(recoverDatabaseRead(database, workerProject, "db-owner", reviewRead)).rejects.toMatchObject({ status: 503 });
          expect((await dockerCommand(["inspect", "--format", "{{.Name}}", foreignName])).trim()).toBe(`/${foreignName}`);
        } finally { await dockerCommand(["rm", "-f", foreignName]); }
        const retryRead = { ...reviewRead, requestId: crypto.randomUUID(),
          expectedRevision: (await readDatabaseResources(database, workerProject, "db-owner")).resources[0]!.revision };
        const recoveredRead = await recoverDatabaseRead(database, workerProject, "db-owner", retryRead);
        expect((await recoverDatabaseRead(database, workerProject, "db-owner", retryRead)).operationId).toBe(recoveredRead.operationId);
        const [oldRead] = await database.select().from(schema.appDatabaseOperations).where(eq(schema.appDatabaseOperations.id, lostRead.id));
        expect(oldRead?.status).toBe("failed");
        expect(oldRead?.effect?.kind).toBe("read-database");
        expect(await hasDatabaseWork(database, workerProject)).toBe(false);
        const [savedResource] = await database
          .select()
          .from(schema.appDatabases)
          .where(eq(schema.appDatabases.id, admitted.resourceId));
        if (!savedResource?.runtimeIdentity)
          throw new Error("Missing saved runtime");
        const uncertainStop = await admitDatabaseAction(
          database,
          workerProject,
          "db-owner",
          {
            ...create(),
            kind: "stop",
            expectedRevision: savedResource.revision,
          },
          directory,
        );
        const stopClaim = await claimDatabaseAction(database);
        if (!stopClaim || stopClaim.id !== uncertainStop.operationId)
          throw new Error("Missing uncertain stop claim");
        await recordDatabaseEffect(database, stopClaim, {
          kind: "stop",
          id: savedResource.runtimeIdentity.containerId,
        });
        await dockerCommand([
          "stop",
          savedResource.runtimeIdentity.containerId,
        ]);
        await interruptDatabaseAction(database, stopClaim);
        const stoppedResource = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources[0];
        if (!stoppedResource) throw new Error("Missing stopped resource");
        const recoveredStop = await recoverInspectedDatabaseAction(
          database,
          workerProject,
          "db-owner",
          {
            requestId: crypto.randomUUID(),
            operationId: stopClaim.id,
            expectedRevision: stoppedResource.revision,
          },
        );
        expect(recoveredStop.replayed).toBe(false);
        const inspected = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources[0];
        expect(inspected?.status).toBe("stopped");
        if (!inspected) throw new Error("Missing inspected state");
        const uncertainStart = await admitDatabaseAction(
          database,
          workerProject,
          "db-owner",
          { ...create(), kind: "start", expectedRevision: inspected.revision },
          directory,
        );
        const startClaim = await claimDatabaseAction(database);
        if (!startClaim || startClaim.id !== uncertainStart.operationId)
          throw new Error("Missing uncertain start claim");
        await recordDatabaseEffect(database, startClaim, {
          kind: "start",
          id: savedResource.runtimeIdentity.containerId,
        });
        await interruptDatabaseAction(database, startClaim);
        const interrupted = (
          await readDatabaseResources(database, workerProject, "db-owner")
        ).resources[0];
        if (!interrupted) throw new Error("Missing start recovery state");
        const recoverStart = {
          requestId: crypto.randomUUID(),
          operationId: startClaim.id,
          expectedRevision: interrupted.revision,
        };
        await expect(
          recoverInspectedDatabaseAction(
            database,
            workerProject,
            "db-owner",
            recoverStart,
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(await hasDatabaseWork(database, workerProject)).toBe(true);
        await dockerCommand([
          "start",
          savedResource.runtimeIdentity.containerId,
        ]);
        const healthDeadline = Date.now() + 15000;
        while (Date.now() < healthDeadline) {
          if (
            (
              await dockerCommand([
                "inspect",
                "--format",
                "{{.State.Health.Status}}",
                savedResource.runtimeIdentity.containerId,
              ])
            ).trim() === "healthy"
          )
            break;
          await new Promise<void>((resolve) => setTimeout(resolve, 150));
        }
        await recoverInspectedDatabaseAction(
          database,
          workerProject,
          "db-owner",
          recoverStart,
        );
        expect(
          (await readDatabaseResources(database, workerProject, "db-owner"))
            .resources[0]?.status,
        ).toBe("ready");
        expect(await hasDatabaseWork(database, workerProject)).toBe(false);
      } finally {
        await worker.stop();
        const filters = [
          "--filter",
          `label=io.wrenly.database-id=${admitted.resourceId}`,
          "--filter",
          `label=io.wrenly.project-id=${workerProject}`,
        ];
        for (const container of (
          await dockerCommand(["ps", "-a", ...filters, "--format", "{{.ID}}"])
        )
          .trim()
          .split("\n")
          .filter(Boolean))
          await dockerCommand(["rm", "--force", "--volumes", container]);
        for (const volume of (
          await dockerCommand([
            "volume",
            "ls",
            ...filters,
            "--format",
            "{{.Name}}",
          ])
        )
          .trim()
          .split("\n")
          .filter(Boolean))
          await dockerCommand(["volume", "rm", volume]);
        for (const network of (
          await dockerCommand([
            "network",
            "ls",
            ...filters,
            "--format",
            "{{.ID}}",
          ])
        )
          .trim()
          .split("\n")
          .filter(Boolean))
          await dockerCommand(["network", "rm", network]);
      }
    },
    process.env.WRENLY_TEST_DATABASE_COMBINED_RUNTIME === "true" ? 600_000 : 360_000,
  );
  test("unresolved database effects fence all project execution and authority reductions", async () => {
    const [project] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    if (!project) throw new Error("Missing policy fixture");
    const [build] = await database
      .insert(schema.builds)
      .values({
        projectId,
        prompt: "Fixture",
        status: "success",
        stack: "nextjs",
        files: [{ path: "package.json", content: "{}" }],
      })
      .returning();
    if (!build) throw new Error("Missing saved revision");
    const dependencies = {
      db: database,
      defaultModel: "fixture",
      resolveProvider: () => ({ id: "openai" }),
    };
    await expect(
      admitBuild(
        { projectId, prompt: "Build fixture" },
        "db-owner",
        crypto.randomUUID(),
        dependencies,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("database"),
    });
    await expect(
      admitConversationTurn(
        projectId,
        "db-owner",
        crypto.randomUUID(),
        { message: "Hello", mode: "auto" },
        dependencies,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("database"),
    });
    await expect(
      admitPreview(database, build.id, "db-owner", crypto.randomUUID()),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("database"),
    });
    await expect(
      admitDeployment(database, {
        projectId,
        buildId: build.id,
        userId: "db-owner",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("database"),
    });
    await expect(
      changeProjectSharing(database, projectId, "db-owner", {
        requestId: crypto.randomUUID(),
        expectedRevision: project.accessRevision,
        mode: "private",
        instanceRole: "viewer",
        members: [],
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("database"),
    });
    await expect(
      changeProjectModel(database, projectId, "db-owner", {
        requestId: crypto.randomUUID(),
        expectedRevision: project.accessRevision,
        connectionId: crypto.randomUUID(),
        modelId: "fixture",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("database"),
    });
    expect(await hasMemberDatabaseWork(database, "db-owner")).toBe(true);
    expect(await hasMemberDatabaseWork(database, "db-viewer")).toBe(false);
  });
  test("racing build and database admission cannot reserve conflicting work", async () => {
    const project = crypto.randomUUID();
    await database
      .insert(schema.projects)
      .values({ id: project, userId: "db-owner", name: "Competing admission" });
    const results = await Promise.allSettled([
      admitDatabaseAction(database, project, "db-owner", create(), directory),
      admitBuild(
        { projectId: project, prompt: "Build fixture" },
        "db-owner",
        crypto.randomUUID(),
        {
          db: database,
          defaultModel: "fixture",
          resolveProvider: () => ({ id: "openai" }),
        },
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const databaseWork = await database
      .select()
      .from(schema.appDatabaseOperations)
      .where(eq(schema.appDatabaseOperations.projectId, project));
    const buildWork = await database
      .select()
      .from(schema.buildJobs)
      .where(eq(schema.buildJobs.projectId, project));
    expect(Boolean(databaseWork.length) && Boolean(buildWork.length)).toBe(
      false,
    );
  });
  test("cleanup acknowledgement preserves unknown primary effects and rejects stale claims", async () => {
    const project = crypto.randomUUID();
    await database
      .insert(schema.projects)
      .values({ id: project, userId: "db-owner", name: "Cleanup fixture" });
    const admitted = await admitDatabaseAction(
      database,
      project,
      "db-owner",
      create(),
      directory,
    );
    const claim = {
      id: admitted.operationId,
      resourceId: admitted.resourceId,
      projectId: project,
      token: crypto.randomUUID(),
    };
    await database
      .update(schema.appDatabaseOperations)
      .set({
        status: "running",
        claimToken: claim.token,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      })
      .where(eq(schema.appDatabaseOperations.id, claim.id));
    await recordDatabaseEffect(database, claim, {
      kind: "apply-migrations",
      id: "unknown-sql",
    });
    const cleanup = {
      kind: "terminate-sessions" as const,
      id: `wrenly-database-administrator-${claim.id}`,
    };
    await recordDatabaseCleanupEffect(database, claim, cleanup);
    await expect(
      acknowledgeDatabaseCleanupEffect(
        database,
        { ...claim, token: crypto.randomUUID() },
        cleanup.id,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      finishDatabaseAction(database, claim, { success: true }),
    ).rejects.toMatchObject({ status: 409 });
    await acknowledgeDatabaseCleanupEffect(database, claim, cleanup.id);
    const [saved] = await database
      .select()
      .from(schema.appDatabaseOperations)
      .where(eq(schema.appDatabaseOperations.id, claim.id));
    expect(saved?.effect?.id).toBe("unknown-sql");
    expect(saved?.cleanupEffect).toBeNull();
    expect(saved?.completedCleanupEffects).toHaveLength(1);
    await expect(
      finishDatabaseAction(database, claim, { success: true }),
    ).rejects.toMatchObject({ status: 409 });
    await interruptDatabaseAction(database, claim);
    expect(await hasDatabaseWork(database, project)).toBe(true);
  });
  test("managed capacity counts stopped, failed and interrupted resources without pruning", async () => {
    const existing = await database
      .select({ id: schema.appDatabases.id })
      .from(schema.appDatabases);
    for (let index = existing.length; index < 8; index++) {
      const project = crypto.randomUUID();
      await database
        .insert(schema.projects)
        .values({ id: project, userId: "db-owner", name: "Capacity fixture" });
      const admitted = await admitDatabaseAction(
        database,
        project,
        "db-owner",
        create(),
        directory,
      );
      await database
        .update(schema.appDatabaseOperations)
        .set({ status: "failed", errorCode: "PREREQUISITE_UNAVAILABLE" })
        .where(eq(schema.appDatabaseOperations.id, admitted.operationId));
      await database
        .update(schema.appDatabases)
        .set({ status: "failed", errorCode: "PREREQUISITE_UNAVAILABLE" })
        .where(eq(schema.appDatabases.id, admitted.resourceId));
    }
    const project = crypto.randomUUID();
    await database
      .insert(schema.projects)
      .values({ id: project, userId: "db-owner", name: "Over capacity" });
    await expect(
      admitDatabaseAction(database, project, "db-owner", create(), directory),
    ).rejects.toMatchObject({
      status: 429,
      message: expect.stringContaining("Managed database capacity"),
    });
    expect((await database.select().from(schema.appDatabases)).length).toBe(8);
    const [retryable] = await database
      .select()
      .from(schema.appDatabases)
      .where(eq(schema.appDatabases.errorCode, "PREREQUISITE_UNAVAILABLE"))
      .limit(1);
    if (!retryable) throw new Error("Missing reserved resource");
    const retried = await admitDatabaseAction(
      database,
      retryable.projectId,
      "db-owner",
      { ...create(), expectedRevision: retryable.revision },
      directory,
    );
    expect(retried.resourceId).toBe(retryable.id);
    expect((await database.select().from(schema.appDatabases)).length).toBe(8);
  });
});
