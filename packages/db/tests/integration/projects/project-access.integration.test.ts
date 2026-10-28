import {
  readPreviewMediaPolicy,
  savePreviewMediaPolicy,
} from "../../../../../apps/api/src/modules/previews/media/preview-media-store";
import { createPreviewMediaHandlers } from "../../../../../apps/api/src/modules/previews/media/preview-media-http";
import {
  previewTokenHash,
  authorizePreviewSession,
} from "../../../../../apps/api/src/modules/previews/access/preview-access";
import { admitConversationTurn } from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
import { admitBuild } from "../../../../../apps/api/src/modules/builds/admission/build-admission";
import {
  changeProjectModel,
  resolveProjectModelSelection,
} from "../../../../../apps/api/src/modules/projects/sharing/project-model";
import { savedProviderIdentity } from "../../../../../apps/api/src/modules/models/selection/saved-providers";
// Exercises project authorization against isolated PostgreSQL records and real policy helpers.
import { afterAll, beforeAll, expect, test, describe } from "bun:test";
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
import { pgTable, uuid, text, integer, timestamp } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  readProjectCapabilities,
  readableProjectPredicate,
  requireProjectCapability,
  verifyProjectAccessSchema,
} from "../../../../../apps/api/src/modules/projects/access/project-access";
import { accessContext } from "../../../../../apps/api/src/modules/auth/access/access-context";

const url = process.env.WRENLY_TEST_PROJECT_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_project_access_test"
  )
    throw new Error(
      "Use only a disposable local wrenly_project_access_test database.",
    );
}
const integration = url ? describe : describe.skip;
integration("project access foundation in PostgreSQL", () => {
  const client = postgres(
    url ?? "postgresql://localhost/wrenly_project_access_test",
    { onnotice: () => {} },
  );
  const database = drizzle(client, { schema });
  const projectId = crypto.randomUUID(),
    sharedId = crypto.randomUUID();
  const actors = [
    "creator",
    "editor",
    "viewer",
    "outsider",
    "administrator",
    "pending",
    "suspended",
  ];
  let temporary = "";
  const oldPreviewId = crypto.randomUUID(),
    oldPreviewToken = "c".repeat(64);
  beforeAll(async () => {
    temporary = await mkdtemp(join(tmpdir(), "wrenly-project-upgrade-"));
    await mkdir(join(temporary, "meta"));
    const source = join(import.meta.dir, "../../../migrations");
    const journal = JSON.parse(
      await readFile(join(source, "meta/_journal.json"), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const previous = {
      ...journal,
      entries: journal.entries.filter((entry) => entry.idx < 20),
    };
    await writeFile(
      join(temporary, "meta/_journal.json"),
      JSON.stringify(previous),
    );
    for (const entry of previous.entries)
      await copyFile(
        join(source, entry.tag + ".sql"),
        join(temporary, entry.tag + ".sql"),
      );
    await migrate(database, { migrationsFolder: temporary });
    await expect(verifyProjectAccessSchema(database)).rejects.toThrow("0028");
    await database.insert(schema.user).values(
      actors.map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        banned: id === "suspended",
      })),
    );
    // The pre-upgrade table deliberately has no collaboration columns.
    const legacyProjects = pgTable("projects", {
      id: uuid("id"),
      userId: text("user_id"),
      name: text("name"),
    });
    await database.insert(legacyProjects).values({
      id: projectId,
      userId: "creator",
      name: "Existing private project",
    });
    const [oldConversation] = await database
      .insert(schema.conversations)
      .values({ projectId })
      .returning();
    if (!oldConversation) throw new Error("Legacy conversation missing");
    const oldTurns = pgTable("conversation_turns", {
      id: uuid("id"),
      conversationId: uuid("conversation_id"),
      idempotencyKey: uuid("idempotency_key"),
      requestIdentity: text("request_identity"),
      mode: text("mode"),
      prompt: text("prompt"),
      model: text("model"),
      provider: text("provider"),
    });
    const oldMessages = pgTable("conversation_messages", {
      conversationId: uuid("conversation_id"),
      turnId: uuid("turn_id"),
      sequence: integer("sequence"),
      role: text("role"),
      content: text("content"),
      kind: text("kind"),
    });
    const oldTurnId = crypto.randomUUID();
    await database.insert(oldTurns).values({
      id: oldTurnId,
      conversationId: oldConversation.id,
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "legacy",
      mode: "ask",
      prompt: "Old prompt",
      model: "fixture",
      provider: "fixture",
    });
    await database.insert(oldMessages).values([
      {
        conversationId: oldConversation.id,
        turnId: oldTurnId,
        sequence: 1,
        role: "user",
        content: "Old prompt",
        kind: "message",
      },
      {
        conversationId: oldConversation.id,
        turnId: oldTurnId,
        sequence: 2,
        role: "assistant",
        content: "Old answer",
        kind: "answer",
      },
    ]);
    const [oldBuild] = await database
      .insert(schema.builds)
      .values({ projectId, prompt: "Legacy preview", status: "success" })
      .returning();
    if (!oldBuild) throw new Error("Legacy build missing");
    await database.insert(schema.previews).values({
      id: oldPreviewId,
      projectId,
      buildId: oldBuild.id,
      userId: "creator",
      files: [],
      status: "ready",
      expiresAt: new Date(Date.now() + 600000),
      leaseExpiresAt: new Date(Date.now() + 600000),
    });
    const oldAccess = pgTable("preview_access", {
      previewId: uuid("preview_id"),
      userId: text("user_id"),
      grantHash: text("grant_hash"),
      grantExpiresAt: timestamp("grant_expires_at", { withTimezone: true }),
      sessionHash: text("session_hash"),
      sessionExpiresAt: timestamp("session_expires_at", { withTimezone: true }),
    });
    await database.insert(oldAccess).values({
      previewId: oldPreviewId,
      userId: "creator",
      grantHash: "old-fixture-grant",
      grantExpiresAt: new Date(Date.now() + 600000),
      sessionHash: previewTokenHash(oldPreviewToken),
      sessionExpiresAt: new Date(Date.now() + 600000),
    });
    await migrate(database, { migrationsFolder: source });
    await verifyProjectAccessSchema(database);
    await database.insert(schema.organization).values({
      id: "instance",
      name: "Fixture",
      slug: "fixture",
      createdAt: new Date(),
    });
    await database.insert(schema.organization).values({
      id: "other",
      name: "Other",
      slug: "other",
      createdAt: new Date(),
    });
    await database.insert(schema.instanceSetup).values({
      id: 1,
      organizationId: "instance",
      ownerId: "administrator",
      initializedAt: new Date(),
    });
    await database.insert(schema.member).values(
      actors
        .filter((id) => id !== "outsider" && id !== "pending")
        .map((id) => ({
          id,
          organizationId: "instance",
          userId: id,
          role: id === "administrator" ? "owner" : "member",
          createdAt: new Date(),
        })),
    );
    await database.insert(schema.member).values({
      id: "other-member",
      organizationId: "other",
      userId: "outsider",
      role: "member",
      createdAt: new Date(),
    });
    await database.insert(schema.projects).values({
      id: sharedId,
      userId: "creator",
      name: "Shared fixture",
      accessMode: "selected",
    });
    await database.insert(schema.projectMembers).values([
      { projectId: sharedId, userId: "editor", role: "editor" },
      { projectId: sharedId, userId: "viewer", role: "viewer" },
      { projectId: sharedId, userId: "outsider", role: "editor" },
      { projectId: sharedId, userId: "pending", role: "editor" },
      { projectId: sharedId, userId: "suspended", role: "editor" },
    ]);
  });
  afterAll(async () => {
    await client.end();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  });
  test("upgrade leaves existing ownership private with a fresh revision and no grants", async () => {
    const [project] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(project?.userId).toBe("creator");
    expect(project?.accessMode).toBe("private");
    expect(project?.accessRevision).toMatch(/^[a-f0-9-]{36}$/);
    expect(
      await readProjectCapabilities(database, projectId, "administrator"),
    ).toBeNull();
    expect(
      (await readProjectCapabilities(database, projectId, "creator"))?.role,
    ).toBe("owner");
  });
  test("old private turns and user messages retain their original author after upgrade", async () => {
    const turns = await database.select().from(schema.conversationTurns);
    expect(turns[0]?.actorId).toBe("creator");
    const messages = await database
      .select()
      .from(schema.conversationMessages)
      .orderBy(schema.conversationMessages.sequence);
    expect(messages.map((message) => message.actorId)).toEqual([
      "creator",
      null,
    ]);
    expect(messages.map((message) => message.content)).toEqual([
      "Old prompt",
      "Old answer",
    ]);
  });
  test("preview grants are bound to the backfilled project revision on upgrade", async () => {
    const [grant] = await database
      .select()
      .from(schema.previewAccess)
      .where(eq(schema.previewAccess.previewId, oldPreviewId));
    const [project] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId));
    expect(grant?.projectRevision).toBe(project?.accessRevision);
    expect(
      await authorizePreviewSession(database, oldPreviewId, oldPreviewToken),
    ).toBeNull();
    await database
      .update(schema.projects)
      .set({ accessRevision: crypto.randomUUID() })
      .where(eq(schema.projects.id, projectId));
    expect(
      await authorizePreviewSession(database, oldPreviewId, oldPreviewToken),
    ).toBeNull();
  });
  test("selected grants and collection predicates agree for every actor", async () => {
    for (const actor of actors) {
      const capability = await readProjectCapabilities(
        database,
        sharedId,
        actor,
      );
      const listed = await database
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(readableProjectPredicate(database, actor));
      expect(listed.some((project) => project.id === sharedId)).toBe(
        Boolean(capability),
      );
      expect(capability?.role ?? null).toBe(
        actor === "creator"
          ? "owner"
          : actor === "editor"
            ? "editor"
            : actor === "viewer"
              ? "viewer"
              : null,
      );
    }
  });
  test("transactional capability checks deny editor management and viewer contribution", async () => {
    await expect(
      database.transaction((tx) =>
        requireProjectCapability(tx, sharedId, "editor", "publish"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      database.transaction((tx) =>
        requireProjectCapability(tx, sharedId, "viewer", "contribute"),
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      database.transaction((tx) =>
        requireProjectCapability(tx, sharedId, "outsider", "read"),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await database.transaction((tx) =>
          requireProjectCapability(tx, sharedId, "editor", "contribute"),
        )
      ).role,
    ).toBe("editor");
  });
  test("everyone includes a newly accepted member, but not another organization", async () => {
    await database
      .update(schema.projects)
      .set({ accessMode: "instance" })
      .where(eq(schema.projects.id, sharedId));
    expect(
      (await readProjectCapabilities(database, sharedId, "administrator"))
        ?.role,
    ).toBe("viewer");
    expect(
      await readProjectCapabilities(database, sharedId, "outsider"),
    ).toBeNull();
    expect(
      await readProjectCapabilities(database, sharedId, "pending"),
    ).toBeNull();
    await database.insert(schema.member).values({
      id: "new-member",
      organizationId: "instance",
      userId: "pending",
      role: "member",
      createdAt: new Date(),
    });
    expect(
      (await readProjectCapabilities(database, sharedId, "pending"))?.role,
    ).toBe("viewer");
    await database
      .update(schema.projects)
      .set({ accessMode: "private" })
      .where(eq(schema.projects.id, sharedId));
    expect(
      await readProjectCapabilities(database, sharedId, "editor"),
    ).toBeNull();
  });
  test("a stale HTTP principal cannot use even creator ownership", async () => {
    const result = await accessContext.run(
      {
        principal: {
          userId: "creator",
          sessionId: "expired-fixture",
          revision: crypto.randomUUID(),
        },
      },
      () => readProjectCapabilities(database, projectId, "creator"),
    );
    expect(result).toBeNull();
  });
  test("owner model changes are audited, replayable, revision checked and credential free", async () => {
    const [project] = await database
      .insert(schema.projects)
      .values({ userId: "creator", name: "Model binding" })
      .returning();
    const [connection] = await database
      .insert(schema.providerConnections)
      .values({
        label: "Fixture",
        protocol: "ollama",
        kind: "local",
        endpoint: "http://127.0.0.1:11434",
      })
      .returning();
    if (!project || !connection) throw new Error("Model fixture missing");
    const input = {
      requestId: crypto.randomUUID(),
      expectedRevision: project.accessRevision,
      connectionId: connection.id,
      modelId: "fixture-model",
    };
    await expect(
      changeProjectModel(database, project.id, "editor", input),
    ).rejects.toMatchObject({ status: 404 });
    const saved = await changeProjectModel(
      database,
      project.id,
      "creator",
      input,
    );
    expect(saved.replayed).toBe(false);
    expect(
      (await changeProjectModel(database, project.id, "creator", input))
        .replayed,
    ).toBe(true);
    await expect(
      changeProjectModel(database, project.id, "creator", {
        ...input,
        modelId: "other",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      changeProjectModel(database, project.id, "creator", {
        ...input,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    const [binding] = await database
      .select()
      .from(schema.projectModels)
      .where(eq(schema.projectModels.projectId, project.id));
    expect(binding?.connectionId).toBe(connection.id);
    expect(Object.keys(binding ?? {}).sort()).toEqual([
      "connectionId",
      "modelId",
      "projectId",
      "updatedAt",
    ]);
    const changed = await changeProjectModel(database, project.id, "creator", {
      ...input,
      requestId: crypto.randomUUID(),
      expectedRevision: saved.currentRevision,
      modelId: "new-model",
    });
    const replay = await changeProjectModel(
      database,
      project.id,
      "creator",
      input,
    );
    expect(replay.savedRevision).toBe(saved.savedRevision);
    expect(replay.currentRevision).toBe(changed.savedRevision);
  });
  test("shared inference uses the binding, rejects overrides and never invokes fallback", async () => {
    const [project] = await database
      .insert(schema.projects)
      .values({
        userId: "creator",
        name: "Shared model",
        accessMode: "selected",
      })
      .returning();
    const [connection] = await database
      .insert(schema.providerConnections)
      .values({
        label: "Shared fixture",
        protocol: "ollama",
        kind: "local",
        endpoint: "http://127.0.0.1:11434",
      })
      .returning();
    if (!project || !connection) throw new Error("Model fixture missing");
    const fallback = async (): Promise<{ provider: string; model: string }> => {
      throw new Error("Forbidden fallback");
    };
    await expect(
      resolveProjectModelSelection(database, project, "editor", {}, fallback),
    ).rejects.toMatchObject({ status: 400 });
    await database.insert(schema.projectModels).values({
      projectId: project.id,
      connectionId: connection.id,
      modelId: "approved",
    });
    const expected = {
      provider: savedProviderIdentity(connection.id, connection.version),
      model: "approved",
    };
    expect(
      await resolveProjectModelSelection(
        database,
        project,
        "editor",
        {},
        fallback,
      ),
    ).toEqual(expected);
    expect(
      await resolveProjectModelSelection(
        database,
        project,
        "editor",
        { provider: connection.id, model: "approved" },
        fallback,
      ),
    ).toEqual(expected);
    for (const input of [
      { model: "expensive-other" },
      { provider: "other-provider" },
      { retry: true, model: "old-model" },
    ])
      await expect(
        resolveProjectModelSelection(
          database,
          project,
          "editor",
          input,
          fallback,
        ),
      ).rejects.toMatchObject({ status: 400 });
    await database
      .update(schema.providerConnections)
      .set({ enabled: false })
      .where(eq(schema.providerConnections.id, connection.id));
    await expect(
      resolveProjectModelSelection(database, project, "editor", {}, fallback),
    ).rejects.toMatchObject({ status: 400 });
    const privateChoice = { provider: "personal-choice", model: "old-model" };
    expect(
      await resolveProjectModelSelection(
        database,
        { ...project, accessMode: "private" },
        "creator",
        {},
        async () => privateChoice,
      ),
    ).toEqual(privateChoice);
    expect(
      await resolveProjectModelSelection(
        database,
        project,
        "creator",
        { retry: true },
        async () => privateChoice,
      ),
    ).toEqual(privateChoice);
  });
  test("active inference blocks model changes without saving a binding or action", async () => {
    const [project] = await database
      .insert(schema.projects)
      .values({ userId: "creator", name: "Busy model" })
      .returning();
    const [connection] = await database
      .insert(schema.providerConnections)
      .values({
        label: "Busy fixture",
        protocol: "ollama",
        kind: "local",
        endpoint: "http://127.0.0.1:11434",
      })
      .returning();
    if (!project || !connection) throw new Error("Model fixture missing");
    const [conversation] = await database
      .insert(schema.conversations)
      .values({ projectId: project.id })
      .returning();
    if (!conversation) throw new Error("Conversation fixture missing");
    const [turn] = await database
      .insert(schema.conversationTurns)
      .values({
        conversationId: conversation.id,
        actorId: "creator",
        idempotencyKey: crypto.randomUUID(),
        requestIdentity: "busy",
        prompt: "busy",
        mode: "ask",
        model: "fixture",
        provider: "fixture",
      })
      .returning();
    const input = {
      requestId: crypto.randomUUID(),
      expectedRevision: project.accessRevision,
      connectionId: connection.id,
      modelId: "new-model",
    };
    await expect(
      changeProjectModel(database, project.id, "creator", input),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await database
        .select()
        .from(schema.projectModels)
        .where(eq(schema.projectModels.projectId, project.id)),
    ).toHaveLength(0);
    expect(
      await database
        .select()
        .from(schema.projectAccessActions)
        .where(eq(schema.projectAccessActions.projectId, project.id)),
    ).toHaveLength(0);
    if (turn)
      await database
        .update(schema.conversationTurns)
        .set({ status: "completed" })
        .where(eq(schema.conversationTurns.id, turn.id));
    await database
      .update(schema.providerConnections)
      .set({ enabled: false })
      .where(eq(schema.providerConnections.id, connection.id));
    await expect(
      changeProjectModel(database, project.id, "creator", input),
    ).rejects.toMatchObject({ status: 400 });
  });
  test("real conversation and build admission enforce and freeze the bound model", async () => {
    const [project] = await database
      .insert(schema.projects)
      .values({
        userId: "creator",
        name: "Bound admission",
        accessMode: "instance",
      })
      .returning();
    const [connection] = await database
      .insert(schema.providerConnections)
      .values({
        label: "Admission fixture",
        protocol: "ollama",
        kind: "local",
        endpoint: "http://127.0.0.1:11434",
      })
      .returning();
    if (!project || !connection) throw new Error("Model fixture missing");
    await database.insert(schema.projectModels).values({
      projectId: project.id,
      connectionId: connection.id,
      modelId: "approved-model",
    });
    const dependencies = {
      db: database,
      defaultModel: "unapproved-default",
      resolveProvider: (): { id: string } => {
        throw new Error("Forbidden default fallback");
      },
    };
    await expect(
      admitConversationTurn(
        project.id,
        "creator",
        crypto.randomUUID(),
        { message: "Question", mode: "ask", model: "override" },
        dependencies,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const turn = await admitConversationTurn(
      project.id,
      "creator",
      crypto.randomUUID(),
      { message: "Question", mode: "ask" },
      dependencies,
    );
    const [saved] = await database
      .select()
      .from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, turn.turnId));
    expect(saved?.model).toBe("approved-model");
    expect(saved?.provider).toBe(
      savedProviderIdentity(connection.id, connection.version),
    );
    await database
      .update(schema.conversationTurns)
      .set({ status: "completed" })
      .where(eq(schema.conversationTurns.id, turn.turnId));
    await expect(
      admitBuild(
        { projectId: project.id, prompt: "Build", model: "override" },
        "creator",
        crypto.randomUUID(),
        dependencies,
      ),
    ).rejects.toMatchObject({ status: 400 });
    const admitted = await admitBuild(
      { projectId: project.id, prompt: "Build" },
      "creator",
      crypto.randomUUID(),
      dependencies,
    );
    const [job] = await database
      .select()
      .from(schema.buildJobs)
      .where(eq(schema.buildJobs.buildId, admitted.buildId));
    expect(job?.input.model).toBe("approved-model");
    expect(job?.input.provider).toBe(
      savedProviderIdentity(connection.id, connection.version),
    );
  });
  test("preview media is owner-only, revision-bound, replayable and revokes prior grants", async () => {
    const id = crypto.randomUUID();
    await database
      .insert(schema.projects)
      .values({
        id,
        userId: "creator",
        name: "Media fixture",
        accessMode: "selected",
      });
    await database.insert(schema.projectMembers).values([
      { projectId: id, userId: "editor", role: "editor" },
      { projectId: id, userId: "viewer", role: "viewer" },
    ]);
    const initial = await readPreviewMediaPolicy(database, id, "creator");
    expect(initial.origins).toEqual([]);
    const action = {
      requestId: crypto.randomUUID(),
      expectedRevision: initial.revision,
      origins: ["https://images.unsplash.com", "https://cdn.example.com"],
    };
    await expect(
      savePreviewMediaPolicy(database, id, "editor", action),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      savePreviewMediaPolicy(database, id, "viewer", action),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      readPreviewMediaPolicy(database, id, "administrator"),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      savePreviewMediaPolicy(database, id, "creator", {
        ...action,
        origins: ["https://127.0.0.1"],
      }),
    ).rejects.toMatchObject({ status: 400 });
    const build = crypto.randomUUID(),
      preview = crypto.randomUUID();
    await database
      .insert(schema.builds)
      .values({
        id: build,
        projectId: id,
        prompt: "Media fixture",
        status: "success",
        files: [],
      });
    await database
      .insert(schema.previews)
      .values({
        id: preview,
        projectId: id,
        buildId: build,
        userId: "creator",
        files: [],
        status: "ready",
        leaseExpiresAt: new Date(Date.now() + 60000),
        expiresAt: new Date(Date.now() + 60000),
      });
    const sessionId = crypto.randomUUID();
    const [creator] = await database.select().from(schema.user).where(eq(schema.user.id, "creator"));
    await database.insert(schema.session).values({ id: sessionId, userId: "creator",
      accessRevision: creator!.accessRevision, token: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60000) });
    const token = "e".repeat(64);
    await database
      .insert(schema.previewAccess)
      .values({
        previewId: preview,
        userId: "creator",
        projectRevision: initial.revision,
        authSessionId: sessionId,
        grantHash: "d".repeat(64),
        grantExpiresAt: new Date(Date.now() + 60000),
        sessionHash: previewTokenHash(token),
        sessionExpiresAt: new Date(Date.now() + 60000),
      });
    expect(await authorizePreviewSession(database, preview, token)).toBe(
      "creator",
    );
    const saved = await savePreviewMediaPolicy(database, id, "creator", action);
    expect(saved.origins).toEqual([...action.origins].sort());
    expect(saved.revision).not.toBe(initial.revision);
    expect(await authorizePreviewSession(database, preview, token)).toBeNull();
    expect(
      (await savePreviewMediaPolicy(database, id, "creator", action)).replayed,
    ).toBe(true);
    await expect(
      savePreviewMediaPolicy(database, id, "creator", {
        ...action,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      savePreviewMediaPolicy(database, id, "creator", {
        ...action,
        origins: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await readPreviewMediaPolicy(database, id, "viewer")).canManage,
    ).toBe(false);
    const http = createPreviewMediaHandlers(database, {
      webUrl: "http://localhost:3000",
      userId: async () => "creator",
    });
    expect(
      (await http.get(new Request("http://localhost/api"), id)).status,
    ).toBe(200);
    expect(
      (
        await http.save(
          new Request("http://localhost/api", {
            method: "PATCH",
            headers: {
              origin: "http://evil.invalid",
              "content-type": "application/json",
            },
            body: JSON.stringify(action),
          }),
          id,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await http.save(
          new Request("http://localhost/api", {
            method: "PATCH",
            headers: {
              origin: "http://localhost:3000",
              "content-type": "application/json",
            },
            body: "x".repeat(4097),
          }),
          id,
        )
      ).status,
    ).toBe(400);
    const removed = await http.save(
      new Request("http://localhost/api", {
        method: "PATCH",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          expectedRevision: saved.revision,
          origins: [],
        }),
      }),
      id,
    );
    expect(removed.status).toBe(200);
    expect((await removed.json()).origins).toEqual([]);
  });
});
