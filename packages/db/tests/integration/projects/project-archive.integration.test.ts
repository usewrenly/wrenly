// Tests reversible project lifecycle metadata without inference, app execution or remote mutation.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  changeProjectArchive,
  readProjectArchive,
} from "../../../../../apps/api/src/modules/projects/archive/project-archive";
import { createProjectArchiveHandlers } from "../../../../../apps/api/src/modules/projects/archive/archive-http";
import { readProjectCapabilities } from "../../../../../apps/api/src/modules/projects/access/project-access";
import { listProjects } from "../../../../../apps/api/src/modules/projects/http/projects";
import { saveProjectSettings } from "../../../../../apps/api/src/modules/projects/settings/project-settings";
import { changeProjectSharing } from "../../../../../apps/api/src/modules/projects/sharing/project-sharing";
import { changeProjectModel } from "../../../../../apps/api/src/modules/projects/sharing/project-model";
import { savePreviewMediaPolicy } from "../../../../../apps/api/src/modules/previews/media/preview-media-store";
import { admitBuild } from "../../../../../apps/api/src/modules/builds/admission/build-admission";
import { claimNextBuild } from "../../../../../apps/api/src/modules/builds/persistence/build-job-store";
import {
  admitConversationTurn,
  claimConversationTurn,
} from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
import {
  admitPreview,
  claimNextPreview,
} from "../../../../../apps/api/src/modules/previews/persistence/preview-store";
import {
  admitDeployment,
  claimNextDeployment,
} from "../../../../../apps/api/src/modules/deployments/persistence/deployment-store";
const url = process.env.WRENLY_TEST_ARCHIVE_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_archive_test"
  )
    throw new Error(
      "Use only a disposable local wrenly_archive_test database.",
    );
}
const suite = url ? describe : describe.skip;
suite("project archive lifecycle", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_archive_test", {
      onnotice: () => {},
    }),
    database = drizzle(client, { schema }),
    projectId = crypto.randomUUID(),
    buildId = crypto.randomUUID(),
    otherProjectId = crypto.randomUUID(),
    otherBuildId = crypto.randomUUID(),
    previewId = crypto.randomUUID(),
    deploymentId = crypto.randomUUID(),
    conversationId = crypto.randomUUID(),
    otherConversationId = crypto.randomUUID();
  const target = {
    gitInstanceUrl: "https://git.example.test",
    repositoryOwner: "fixture",
    coolifyInstanceUrl: "https://coolify.example.test",
    coolifyProjectUuid: "project",
    coolifyServerUuid: "server",
    coolifyEnvironmentName: "production",
  };
  const jobInput = {
    prompt: "fixture",
    stack: "nextjs" as const,
    model: "fixture",
    provider: "fixture",
    previousFiles: [],
    previousErrors: [],
  };
  let revision = "",
    archiveRequest = {
      requestId: crypto.randomUUID(),
      expectedRevision: "",
      archived: true,
    };
  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: new URL("../../../migrations", import.meta.url).pathname,
    });
    await database.insert(schema.user).values(
      ["owner", "editor", "admin", "outsider"].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
      })),
    );
    await database.insert(schema.organization).values({
      id: "instance",
      name: "fixture",
      slug: "fixture",
      createdAt: new Date(),
    });
    await database.insert(schema.instanceSetup).values({
      id: 1,
      ownerId: "admin",
      organizationId: "instance",
      initializedAt: new Date(),
    });
    await database.insert(schema.member).values(
      ["owner", "editor", "admin"].map((id) => ({
        id,
        userId: id,
        organizationId: "instance",
        role: id === "admin" ? "owner" : "member",
        createdAt: new Date(),
      })),
    );
    await database.insert(schema.projects).values([
      {
        id: projectId,
        userId: "owner",
        name: "Keep the history",
        accessMode: "selected",
      },
      { id: otherProjectId, userId: "owner", name: "Other active work" },
    ]);
    await database
      .insert(schema.projectMembers)
      .values({ projectId, userId: "editor", role: "editor" });
    await database.insert(schema.builds).values([
      {
        id: buildId,
        projectId,
        prompt: "Saved source",
        status: "success",
        files: [{ path: "app/page.tsx", content: "saved source" }],
        deployedUrl: "https://published.example.test",
      },
      {
        id: otherBuildId,
        projectId: otherProjectId,
        prompt: "Other source",
        status: "success",
        files: [],
      },
    ]);
    await database.insert(schema.conversations).values([
      { id: conversationId, projectId },
      { id: otherConversationId, projectId: otherProjectId },
    ]);
    for (const id of [projectId, otherProjectId])
      await database
        .insert(schema.deploymentResources)
        .values({ projectId: id, ...target, repositoryName: `fixture-${id}` });
    await database.insert(schema.deployments).values({
      id: deploymentId,
      projectId,
      buildId,
      userId: "owner",
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "fixture",
      stack: "nextjs",
      files: [],
      sourceSha256: "0".repeat(64),
      status: "success",
      url: "https://published.example.test",
    });
    revision = (await readProjectArchive(database, projectId, "owner"))
      .revision;
  });
  afterAll(async () => {
    await client.end();
  });
  const change = (): Promise<unknown> =>
    changeProjectArchive(database, projectId, "owner", {
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
      archived: true,
    });
  test("owner-only change and immutable successful deployment history", async () => {
    expect(
      (await readProjectArchive(database, projectId, "editor")).canManage,
    ).toBe(false);
    await expect(
      changeProjectArchive(database, projectId, "editor", {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        archived: true,
      }),
    ).rejects.toThrow("Only the project owner");
    await expect(
      readProjectArchive(database, projectId, "admin"),
    ).rejects.toThrow("not found");
    expect(
      (await readProjectArchive(database, projectId, "owner")).blockers,
    ).toEqual([]);
  });
  test("active, interrupted and cleanup-pending work each blocks archive without cancelling it", async () => {
    await database
      .update(schema.builds)
      .set({ status: "building" })
      .where(eq(schema.builds.id, buildId));
    await expect(change()).rejects.toThrow("active build");
    await database
      .update(schema.builds)
      .set({ status: "success" })
      .where(eq(schema.builds.id, buildId));
    await database.insert(schema.buildJobs).values({
      buildId,
      projectId,
      userId: "owner",
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "fixture",
      input: jobInput,
      status: "queued",
    });
    await expect(change()).rejects.toThrow("active build");
    await database
      .update(schema.buildJobs)
      .set({ status: "cancelled", completedAt: new Date() })
      .where(eq(schema.buildJobs.buildId, buildId));
    const turnId = crypto.randomUUID();
    await database.insert(schema.conversationTurns).values({
      id: turnId,
      conversationId,
      actorId: "owner",
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "fixture",
      mode: "auto",
      prompt: "fixture",
      model: "fixture",
      provider: "fixture",
      status: "running",
    });
    await expect(change()).rejects.toThrow("active conversation");
    await database
      .update(schema.conversationTurns)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(schema.conversationTurns.id, turnId));
    await database.insert(schema.previews).values({
      id: previewId,
      projectId,
      buildId,
      userId: "owner",
      files: [],
      status: "ready",
    });
    await expect(change()).rejects.toThrow("Stop the local preview");
    await database
      .update(schema.previews)
      .set({ status: "stopped" })
      .where(eq(schema.previews.id, previewId));
    await expect(change()).rejects.toThrow("cleanup");
    await database
      .update(schema.previews)
      .set({ cleanupCompletedAt: new Date() })
      .where(eq(schema.previews.id, previewId));
    await database
      .update(schema.deployments)
      .set({
        status: "interrupted",
        mutationIntent: {
          kind: "create_application",
          operationId: crypto.randomUUID(),
        },
      })
      .where(eq(schema.deployments.id, deploymentId));
    await expect(change()).rejects.toThrow("publishing");
    await database
      .update(schema.deployments)
      .set({ status: "success", mutationIntent: null })
      .where(eq(schema.deployments.id, deploymentId));
    const databaseId = crypto.randomUUID(),
      operationId = crypto.randomUUID();
    await database.insert(schema.appDatabases).values({
      id: databaseId,
      projectId,
      environment: "development",
      provider: "fixture",
      createdBy: "owner",
      secrets: {
        version: 1,
        keyId: "fixture",
        nonce: "fixture",
        tag: "fixture",
        ciphertext: "fixture",
      },
    });
    await database.insert(schema.appDatabaseOperations).values({
      id: operationId,
      databaseId,
      projectId,
      actorId: "owner",
      requestId: crypto.randomUUID(),
      requestIdentity: "fixture",
      kind: "create",
      status: "interrupted",
    });
    await expect(change()).rejects.toThrow("database work");
    await database
      .update(schema.appDatabaseOperations)
      .set({ status: "failed", completedAt: new Date() })
      .where(eq(schema.appDatabaseOperations.id, operationId));
    expect(
      (await readProjectArchive(database, projectId, "owner")).blockers,
    ).toEqual([]);
  });
  test("archive is CAS/replay-safe, revokes grants and keeps authorized reads and live URLs", async () => {
    await database.insert(schema.previewAccess).values({
      previewId,
      userId: "editor",
      projectRevision: revision,
      grantHash: "a".repeat(64),
      grantExpiresAt: new Date(Date.now() + 60000),
    });
    archiveRequest = { ...archiveRequest, expectedRevision: revision };
    const saved = await changeProjectArchive(
      database,
      projectId,
      "owner",
      archiveRequest,
    );
    revision = saved.revision;
    expect(saved.archivedAt).not.toBeNull();
    expect(
      (await changeProjectArchive(database, projectId, "owner", archiveRequest))
        .replayed,
    ).toBe(true);
    await expect(
      changeProjectArchive(database, projectId, "owner", {
        ...archiveRequest,
        archived: false,
      }),
    ).rejects.toThrow("another project change");
    await expect(
      changeProjectArchive(database, projectId, "owner", {
        ...archiveRequest,
        requestId: crypto.randomUUID(),
        archived: false,
      }),
    ).rejects.toThrow("settings changed");
    expect(await database.select().from(schema.previewAccess)).toHaveLength(0);
    expect(
      await readProjectCapabilities(database, projectId, "editor"),
    ).toEqual({
      role: "editor",
      read: true,
      contribute: false,
      manage: false,
      publish: false,
    });
    const [build] = await database
      .select()
      .from(schema.builds)
      .where(eq(schema.builds.id, buildId));
    expect(build?.files).toEqual([
      { path: "app/page.tsx", content: "saved source" },
    ]);
    expect(build?.deployedUrl).toBe("https://published.example.test");
    const [deployment] = await database
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deploymentId));
    expect(deployment?.url).toBe("https://published.example.test");
    expect(deployment?.status).toBe("success");
  });
  test("all new work and metadata/model/sharing/media writes are fenced", async () => {
    const deps = {
      db: database,
      defaultModel: "fixture",
      resolveProvider: () => ({ id: "fixture" }),
    };
    await expect(
      admitBuild(
        { projectId, prompt: "New work", stack: "nextjs" },
        "owner",
        crypto.randomUUID(),
        deps,
      ),
    ).rejects.toThrow("role");
    await expect(
      admitConversationTurn(
        projectId,
        "editor",
        crypto.randomUUID(),
        { message: "New work", mode: "auto" },
        deps,
      ),
    ).rejects.toThrow("role");
    await expect(
      admitPreview(database, buildId, "owner", crypto.randomUUID()),
    ).rejects.toThrow("role");
    await expect(
      admitDeployment(database, {
        projectId,
        buildId,
        userId: "owner",
        idempotencyKey: crypto.randomUUID(),
        target,
      }),
    ).rejects.toThrow("Restore this project");
    await expect(
      saveProjectSettings(database, "owner", projectId, {
        name: "Changed",
        description: null,
        expected: { name: "Keep the history", description: null },
      }),
    ).rejects.toThrow("Restore this project");
    await expect(
      changeProjectSharing(database, projectId, "owner", {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        mode: "private",
        instanceRole: "viewer",
        members: [],
      }),
    ).rejects.toThrow("role");
    await expect(
      changeProjectModel(database, projectId, "owner", {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        connectionId: crypto.randomUUID(),
        modelId: "fixture",
      }),
    ).rejects.toThrow("role");
    await expect(
      savePreviewMediaPolicy(database, projectId, "owner", {
        requestId: crypto.randomUUID(),
        expectedRevision: revision,
        origins: [],
      }),
    ).rejects.toThrow("role");
  });
  test("default lists hide archived work; explicit archived collection retains read authorization", async () => {
    const request = (actor: string, archived = false) =>
      listProjects(
        new Request(
          "http://localhost/api/projects" + (archived ? "?archived=true" : ""),
        ),
        { database, session: async () => actor },
      );
    const active = (await (await request("owner")).json()) as {
      projects: Array<{ id: string }>;
    };
    expect(active.projects.map((row) => row.id)).not.toContain(projectId);
    const archived = (await (await request("editor", true)).json()) as {
      projects: Array<{ id: string }>;
    };
    expect(archived.projects.map((row) => row.id)).toContain(projectId);
    const denied = (await (await request("admin", true)).json()) as {
      projects: unknown[];
    };
    expect(denied.projects).toHaveLength(0);
  });
  test("claims skip inconsistent archived queued records and can still claim other projects", async () => {
    await database
      .update(schema.buildJobs)
      .set({ status: "queued" })
      .where(eq(schema.buildJobs.buildId, buildId));
    await database.insert(schema.buildJobs).values({
      buildId: otherBuildId,
      projectId: otherProjectId,
      userId: "owner",
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "other",
      input: jobInput,
      status: "queued",
    });
    const job = await claimNextBuild(database);
    expect(job?.buildId).toBe(otherBuildId);
    await database.update(schema.buildJobs).set({
      status: "cancelled",
      completedAt: new Date(),
      claimToken: null,
      leaseExpiresAt: null,
    });
    await database
      .update(schema.builds)
      .set({ status: "success" })
      .where(eq(schema.builds.id, otherBuildId));
    const turnIds = [crypto.randomUUID(), crypto.randomUUID()];
    await database.insert(schema.conversationTurns).values(
      turnIds.map((id, index) => ({
        id,
        conversationId: index ? otherConversationId : conversationId,
        actorId: "owner",
        idempotencyKey: crypto.randomUUID(),
        requestIdentity: "claim",
        mode: "auto" as const,
        prompt: "fixture",
        model: "fixture",
        provider: "fixture",
        status: "queued" as const,
      })),
    );
    const turn = await claimConversationTurn(database);
    expect(turn?.turnId).toBe(turnIds[1]);
    for (const id of turnIds)
      await database
        .update(schema.conversationTurns)
        .set({
          status: "cancelled",
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(schema.conversationTurns.id, id));
    const otherPreview = crypto.randomUUID();
    await database
      .update(schema.previews)
      .set({ status: "queued", cleanupCompletedAt: null })
      .where(eq(schema.previews.id, previewId));
    await database.insert(schema.previews).values({
      id: otherPreview,
      projectId: otherProjectId,
      buildId: otherBuildId,
      userId: "owner",
      files: [],
      status: "queued",
    });
    expect((await claimNextPreview(database))?.previewId).toBe(otherPreview);
    await database.update(schema.previews).set({
      status: "stopped",
      cleanupCompletedAt: new Date(),
      claimToken: null,
      leaseExpiresAt: null,
    });
    const otherDeployment = crypto.randomUUID();
    await database
      .update(schema.deployments)
      .set({ status: "queued" })
      .where(eq(schema.deployments.id, deploymentId));
    await database.insert(schema.deployments).values({
      id: otherDeployment,
      projectId: otherProjectId,
      buildId: otherBuildId,
      userId: "owner",
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "other",
      stack: "nextjs",
      files: [],
      sourceSha256: "0".repeat(64),
      status: "queued",
    });
    expect((await claimNextDeployment(database))?.deploymentId).toBe(
      otherDeployment,
    );
    await database
      .update(schema.deployments)
      .set({ status: "success", claimToken: null, leaseExpiresAt: null });
  });
  test("restore preserves sharing and does not admit or restart prior work", async () => {
    const restored = await changeProjectArchive(database, projectId, "owner", {
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
      archived: false,
    });
    revision = restored.revision;
    expect(restored.archivedAt).toBeNull();
    expect(
      (await readProjectCapabilities(database, projectId, "editor"))
        ?.contribute,
    ).toBe(true);
    expect(await claimNextBuild(database)).toBeNull();
    expect(await claimConversationTurn(database)).toBeNull();
    expect(await claimNextPreview(database)).toBeNull();
    expect(await claimNextDeployment(database)).toBeNull();
    expect(await database.select().from(schema.projectMembers)).toHaveLength(1);
  });
  test("archive and new build admission cannot both win a race", async () => {
    const id = crypto.randomUUID();
    await database
      .insert(schema.projects)
      .values({ id, userId: "owner", name: "Race fixture" });
    const initial = await readProjectArchive(database, id, "owner");
    const result = await Promise.allSettled([
      changeProjectArchive(database, id, "owner", {
        requestId: crypto.randomUUID(),
        expectedRevision: initial.revision,
        archived: true,
      }),
      admitBuild(
        { projectId: id, prompt: "New work", stack: "nextjs" },
        "owner",
        crypto.randomUUID(),
        {
          db: database,
          defaultModel: "fixture",
          resolveProvider: () => ({ id: "fixture" }),
        },
      ),
    ]);
    expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    const [project] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    const jobs = await database
      .select()
      .from(schema.buildJobs)
      .where(eq(schema.buildJobs.projectId, id));
    expect(Boolean(project?.archivedAt)).toBe(jobs.length === 0);
  });
  test("HTTP protects origin, strict bodies and owner authority", async () => {
    const http = createProjectArchiveHandlers(database, {
      webUrl: "http://localhost:3000",
      userId: async (headers) => headers.get("x-fixture-user"),
    });
    const request = (
      body: string,
      origin = "http://localhost:3000",
      actor = "owner",
    ) =>
      new Request("http://localhost/api", {
        method: "PATCH",
        headers: {
          origin,
          "content-type": "application/json",
          "x-fixture-user": actor,
        },
        body,
      });
    expect(
      (await http.save(request("bad", "http://evil.test", ""), projectId))
        .status,
    ).toBe(401);
    expect(
      (await http.save(request("bad", "http://evil.test"), projectId)).status,
    ).toBe(403);
    expect((await http.save(request("x".repeat(4097)), projectId)).status).toBe(
      400,
    );
    const response = await http.save(
      request(
        JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          archived: true,
        }),
        "http://localhost:3000",
        "editor",
      ),
      projectId,
    );
    expect(response.status).toBe(403);
  });
});
