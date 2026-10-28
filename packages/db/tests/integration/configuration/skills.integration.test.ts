import { getOwnedBuild } from "../../../../../apps/api/src/modules/builds/persistence/build-queries";
import { getProjectAccessAction } from "../../../../../apps/api/src/modules/projects/sharing/project-sharing";
import {
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  mkdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { admitBuild } from "../../../../../apps/api/src/modules/builds/admission/build-admission";
import {
  admitConversationTurn,
  claimConversationTurn,
  completeConversationAnswer,
  getConversationHistory,
} from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
import { admitConversationBuildAction } from "../../../../../apps/api/src/modules/conversations/execution/conversation-actions";
import { loadConversationContext } from "../../../../../apps/api/src/modules/conversations/execution/conversation-context";
import { inferConversationDecision } from "../../../../../apps/api/src/modules/conversations/execution/conversation-model";
import { verifySkillsSchema } from "../../../../../apps/api/src/modules/skills/skill-store";
// Disposable local DB only; no provider, inference or operator database is contacted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  createSkill,
  changeSkill,
  listSkills,
  readSkill,
  getSkillAction,
} from "../../../../../apps/api/src/modules/skills/skill-store";
import {
  changeProjectSkills,
  readProjectSkills,
  freezeProjectSkills,
} from "../../../../../apps/api/src/modules/skills/project-skills";
import { accessContext } from "../../../../../apps/api/src/modules/auth/access/access-context";
const testUrl = process.env.WRENLY_TEST_SKILLS_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (
    url.pathname !== "/wrenly_skills_test" ||
    !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error(
      "Skills tests require a disposable local wrenly_skills_test database.",
    );
}
const integration = testUrl ? describe : describe.skip;
integration("versioned personal skills", () => {
  const client = postgres(
    testUrl ?? "postgresql://localhost/wrenly_skills_test",
    { max: 4 },
  );
  const db = drizzle(client, { schema });
  const actors = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  const actor = actors[0]!,
    other = actors[1]!,
    quotaActor = actors[2]!;
  const organizationId = crypto.randomUUID();
  const document =
    "---\nname: clear-copy\ndescription: Write clear interface text\n---\nUse concrete verbs.";
  const input = (): {
    requestId: string;
    skillId: string;
    document: string;
    source: "imported";
    sourceUrl: string;
    versionLabel: string;
    licenseNotes: string;
  } => ({
    requestId: crypto.randomUUID(),
    skillId: crypto.randomUUID(),
    document,
    source: "imported",
    sourceUrl: "https://example.test/skills/clear-copy",
    versionLabel: "1.0",
    licenseNotes: "Fixture source, reviewed locally.",
  });
  const legacyProject = crypto.randomUUID(),
    legacyTurnId = crypto.randomUUID();
  beforeAll(async () => {
    const alreadyUpgraded = await verifySkillsSchema(db).then(
      () => true,
      () => false,
    );
    const directory = await mkdtemp(join(tmpdir(), "wrenly-skills-upgrade-"));
    try {
      await mkdir(join(directory, "meta"));
      const folder = `${import.meta.dir}/../../../migrations`;
      const journal = JSON.parse(
        await readFile(join(folder, "meta/_journal.json"), "utf8"),
      ) as { entries: Array<{ idx: number; tag: string }> };
      const old = {
        ...journal,
        entries: journal.entries.filter((entry) => entry.idx < 30),
      };
      await writeFile(
        join(directory, "meta/_journal.json"),
        JSON.stringify(old),
      );
      for (const entry of old.entries)
        await copyFile(
          join(folder, entry.tag + ".sql"),
          join(directory, entry.tag + ".sql"),
        );
      await migrate(db, { migrationsFolder: directory });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    await db.insert(schema.user).values(
      actors.map((id) => ({
        id,
        name: "Skills fixture",
        email: `${id}@example.test`,
      })),
    );
    await db.insert(schema.projects).values({
      id: legacyProject,
      userId: actor,
      name: "Before Skills",
      stack: "nextjs",
    });
    const conversationId = crypto.randomUUID();
    await db
      .insert(schema.conversations)
      .values({ id: conversationId, projectId: legacyProject });
    const oldTurns = pgTable("conversation_turns", {
      id: uuid("id"),
      conversationId: uuid("conversation_id"),
      actorId: text("actor_id"),
      idempotencyKey: uuid("idempotency_key"),
      requestIdentity: text("request_identity"),
      prompt: text("prompt"),
      mode: text("mode"),
      model: text("model"),
      provider: text("provider"),
      status: text("status"),
    });
    await db.insert(oldTurns).values({
      id: legacyTurnId,
      conversationId,
      actorId: actor,
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "legacy",
      prompt: "Legacy question",
      mode: "ask",
      model: "fixture",
      provider: "fixture",
      status: "completed",
    });
    if (!alreadyUpgraded)
      await expect(verifySkillsSchema(db)).rejects.toThrow(
        "migrations through 0030",
      );
    await migrate(db, { migrationsFolder: `${import.meta.dir}/../../../migrations` });
    await verifySkillsSchema(db);
    await db.insert(schema.organization).values({
      id: organizationId,
      slug: organizationId,
      name: "Fixture",
      createdAt: new Date(),
    });
    await db.insert(schema.instanceSetup).values({
      id: 1,
      ownerId: actor,
      organizationId,
      initializedAt: new Date(),
    });
    await db.insert(schema.member).values(
      actors.map((userId) => ({
        id: crypto.randomUUID(),
        organizationId,
        userId,
        role: "member",
        createdAt: new Date(),
      })),
    );
  });
  afterAll(async () => {
    try {
      await db
        .delete(schema.conversationActions)
        .where(
          inArray(
            schema.conversationActions.buildId,
            db
              .select({ id: schema.builds.id })
              .from(schema.builds)
              .innerJoin(
                schema.projects,
                eq(schema.projects.id, schema.builds.projectId),
              )
              .where(inArray(schema.projects.userId, actors)),
          ),
        );
      await db
        .delete(schema.projectAccessActions)
        .where(inArray(schema.projectAccessActions.actorId, actors));
      await db
        .delete(schema.projects)
        .where(inArray(schema.projects.userId, actors));
      await db
        .delete(schema.instanceSetup)
        .where(eq(schema.instanceSetup.ownerId, actor));
      await db
        .delete(schema.organization)
        .where(eq(schema.organization.id, organizationId));
      await db
        .delete(schema.skillActions)
        .where(inArray(schema.skillActions.actorId, actors));
      const owned = await db
        .select({ id: schema.skills.id })
        .from(schema.skills)
        .where(inArray(schema.skills.ownerId, actors));
      if (owned.length)
        await db.delete(schema.skillVersions).where(
          inArray(
            schema.skillVersions.skillId,
            owned.map((row) => row.id),
          ),
        );
      await db
        .delete(schema.skills)
        .where(inArray(schema.skills.ownerId, actors));
      await db
        .delete(schema.skillLibraries)
        .where(inArray(schema.skillLibraries.ownerId, actors));
      await db.delete(schema.user).where(inArray(schema.user.id, actors));
    } finally {
      await client.end();
    }
  });
  test("upgrade preserves existing projects and gives legacy turns empty guidance", async () => {
    const [legacy] = await db
      .select()
      .from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, legacyTurnId));
    expect(legacy?.skillsV1).toEqual({ version: 1, skills: [] });
    expect(
      (await readProjectSkills(db, legacyProject, actor)).selected,
    ).toEqual([]);
  });
  test("create replay is exact and actor-scoped; content history/provenance stay immutable", async () => {
    const body = input();
    const first = await createSkill(db, actor, body);
    const again = await createSkill(db, actor, body);
    expect(again).toEqual({ ...first, replayed: true });
    await expect(
      createSkill(db, actor, { ...body, document: document + "\nChanged" }),
    ).rejects.toMatchObject({ status: 409 });
    const second = await changeSkill(db, actor, body.skillId, {
      kind: "content",
      requestId: crypto.randomUUID(),
      expectedRevision: first.currentRevision,
      document: document + "\nPrefer short labels.",
      source: "authored",
      sourceUrl: null,
      versionLabel: "2.0",
      licenseNotes: "Edited by owner.",
    });
    expect(second.versionId).not.toBe(first.versionId);
    const versions = await db
      .select()
      .from(schema.skillVersions)
      .where(eq(schema.skillVersions.skillId, body.skillId));
    expect(versions).toHaveLength(2);
    expect(versions.find((row) => row.id === first.versionId)?.document).toBe(
      document,
    );
    expect(versions.find((row) => row.id === first.versionId)?.sourceUrl).toBe(
      body.sourceUrl,
    );
    expect(
      await getSkillAction(db, actor, body.skillId, body.requestId),
    ).toEqual({
      ...first,
      currentRevision: second.currentRevision,
      replayed: true,
    });
  });
  test("other accounts cannot read, change, archive or reconcile a private skill", async () => {
    const body = input(),
      first = await createSkill(db, actor, body);
    await expect(readSkill(db, other, body.skillId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      changeSkill(db, other, body.skillId, {
        kind: "archive",
        requestId: crypto.randomUUID(),
        expectedRevision: first.currentRevision,
        archived: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await getSkillAction(db, other, body.skillId, body.requestId),
    ).toBeNull();
    expect(await listSkills(db, other)).toEqual({ skills: [] });
    await expect(
      createSkill(db, other, { ...body, requestId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("archive/restore preserves version and stale changes cannot overwrite it", async () => {
    const body = input(),
      first = await createSkill(db, actor, body);
    const freeze = {
      kind: "archive",
      requestId: crypto.randomUUID(),
      expectedRevision: first.currentRevision,
      archived: true,
    };
    const archived = await changeSkill(db, actor, body.skillId, freeze);
    expect(archived.versionId).toBe(first.versionId);
    await expect(
      changeSkill(db, actor, body.skillId, {
        ...freeze,
        requestId: crypto.randomUUID(),
        archived: false,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await changeSkill(db, actor, body.skillId, freeze)).toEqual({
      ...archived,
      replayed: true,
    });
    const restored = await changeSkill(db, actor, body.skillId, {
      kind: "archive",
      requestId: crypto.randomUUID(),
      expectedRevision: archived.currentRevision,
      archived: false,
    });
    expect(restored.versionId).toBe(first.versionId);
    const [saved] = await db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, body.skillId));
    expect(saved?.archivedAt).toBeNull();
  });
  test("invalid document rolls back all effects and leaves its UUID reusable for the reviewed request", async () => {
    const body = input();
    await expect(
      createSkill(db, actor, { ...body, document: "not a SKILL.md" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(
      await getSkillAction(db, actor, body.skillId, body.requestId),
    ).toBeNull();
    expect((await createSkill(db, actor, body)).replayed).toBe(false);
  });
  test("concurrent exact creates have one durable version and reconcile before retry", async () => {
    const body = input();
    const results = await Promise.allSettled([
      createSkill(db, actor, body),
      createSkill(db, actor, body),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    const ack = await getSkillAction(db, actor, body.skillId, body.requestId);
    expect(ack?.skillId).toBe(body.skillId);
    const versions = await db
      .select()
      .from(schema.skillVersions)
      .where(eq(schema.skillVersions.skillId, body.skillId));
    expect(versions).toHaveLength(1);
    expect((await createSkill(db, actor, body)).replayed).toBe(true);
  });
  test("suspension and stale revision-bound principals cannot read or write", async () => {
    const body = input();
    await db
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, other));
    await expect(createSkill(db, other, body)).rejects.toMatchObject({
      name: "AccessDeniedError",
    });
    await expect(listSkills(db, other)).rejects.toMatchObject({
      name: "AccessDeniedError",
    });
    await db
      .update(schema.user)
      .set({ banned: false })
      .where(eq(schema.user.id, other));
    await expect(
      accessContext.run(
        {
          principal: {
            userId: actor,
            revision: crypto.randomUUID(),
            sessionId: "stale",
          },
        },
        () => listSkills(db, actor),
      ),
    ).rejects.toMatchObject({ name: "AccessDeniedError" });
  });

  test("project binding is owner-only, exposes reviewed guidance to readers and freezes exact versions", async () => {
    const body = input(),
      saved = await createSkill(db, actor, body),
      projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      userId: actor,
      name: "Shared",
      stack: "nextjs",
      accessMode: "instance",
      instanceRole: "viewer",
    });
    const initial = await readProjectSkills(db, projectId, actor);
    const change = {
      requestId: crypto.randomUUID(),
      expectedRevision: initial.revision,
      versionIds: [saved.versionId],
    };
    await expect(
      changeProjectSkills(db, projectId, other, change),
    ).rejects.toMatchObject({ status: 403 });
    const selected = await changeProjectSkills(db, projectId, actor, change);
    expect(selected.selected[0]?.versionId).toBe(saved.versionId);
    expect((await readProjectSkills(db, projectId, other)).canManage).toBe(
      false,
    );
    expect(
      (await readProjectSkills(db, projectId, other)).selected[0]?.document,
    ).toBe(document);
    await db
      .update(schema.projects)
      .set({ instanceRole: "editor" })
      .where(eq(schema.projects.id, projectId));
    await expect(
      changeProjectSkills(db, projectId, other, {
        ...change,
        expectedRevision: selected.revision,
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await changeProjectSkills(db, projectId, actor, change)).replayed,
    ).toBe(true);
    await expect(
      changeProjectSkills(db, projectId, actor, { ...change, versionIds: [] }),
    ).rejects.toMatchObject({ status: 409 });
    const snapshot = await db.transaction((tx) =>
      freezeProjectSkills(tx, projectId),
    );
    await changeSkill(db, actor, body.skillId, {
      kind: "content",
      requestId: crypto.randomUUID(),
      expectedRevision: saved.currentRevision,
      document: document + "\nNew instructions.",
      source: "authored",
      sourceUrl: null,
      versionLabel: null,
      licenseNotes: "",
    });
    expect(
      (await db.transaction((tx) => freezeProjectSkills(tx, projectId)))[0]
        ?.document,
    ).toBe(document);
    const [head] = await db
      .select()
      .from(schema.skills)
      .where(eq(schema.skills.id, body.skillId));
    await changeSkill(db, actor, body.skillId, {
      kind: "archive",
      requestId: crypto.randomUUID(),
      expectedRevision: head!.revision,
      archived: true,
    });
    await expect(
      db.transaction((tx) => freezeProjectSkills(tx, projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(snapshot[0]?.document).toBe(document);
    expect(
      (await readProjectSkills(db, projectId, other)).selected[0]?.archived,
    ).toBe(true);
  });
  test("project selection rejects foreign versions, stale CAS, active work and archived projects", async () => {
    const own = await createSkill(db, actor, input()),
      foreign = await createSkill(db, other, input()),
      projectId = crypto.randomUUID();
    await db.insert(schema.projects).values({
      id: projectId,
      userId: actor,
      name: "Private",
      stack: "laravel",
    });
    const initial = await readProjectSkills(db, projectId, actor);
    await expect(readProjectSkills(db, projectId, other)).rejects.toMatchObject(
      { status: 404 },
    );
    const change = {
      requestId: crypto.randomUUID(),
      expectedRevision: initial.revision,
      versionIds: [foreign.versionId],
    };
    await expect(
      changeProjectSkills(db, projectId, actor, change),
    ).rejects.toMatchObject({ status: 400 });
    const buildId = crypto.randomUUID();
    await db
      .insert(schema.builds)
      .values({ id: buildId, projectId, prompt: "Fixture", status: "pending" });
    await expect(
      changeProjectSkills(db, projectId, actor, {
        ...change,
        versionIds: [own.versionId],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await db
      .update(schema.builds)
      .set({ status: "failed" })
      .where(eq(schema.builds.id, buildId));
    const saved = await changeProjectSkills(db, projectId, actor, {
      ...change,
      versionIds: [own.versionId],
    });
    await expect(
      changeProjectSkills(db, projectId, actor, {
        ...change,
        requestId: crypto.randomUUID(),
        versionIds: [],
      }),
    ).rejects.toMatchObject({ status: 409 });
    await db
      .update(schema.projects)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    await expect(
      changeProjectSkills(db, projectId, actor, {
        requestId: crypto.randomUUID(),
        expectedRevision: saved.revision,
        versionIds: [],
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await getProjectAccessAction(db, projectId, actor, change.requestId),
    ).toEqual({
      savedRevision: saved.revision,
      currentRevision: saved.revision,
    });
    await expect(
      getProjectAccessAction(db, projectId, other, change.requestId),
    ).rejects.toMatchObject({ status: 404 });
  });

  for (const stack of ["nextjs", "laravel"] as const)
    test(`${stack} build admission and explicit retry preserve original guidance after archive/reselection`, async () => {
      const body = input(),
        original = await createSkill(db, actor, body),
        projectId = crypto.randomUUID();
      await db
        .insert(schema.projects)
        .values({ id: projectId, userId: actor, name: "Frozen build", stack });
      const initial = await readProjectSkills(db, projectId, actor);
      await changeProjectSkills(db, projectId, actor, {
        requestId: crypto.randomUUID(),
        expectedRevision: initial.revision,
        versionIds: [original.versionId],
      });
      const dependencies = {
        db,
        defaultModel: "fixture",
        resolveProvider: () => ({ id: "fixture" }),
      };
      const first = await admitBuild(
        { projectId, prompt: "Build with reviewed guidance" },
        actor,
        crypto.randomUUID(),
        dependencies,
      );
      const [job] = await db
        .select()
        .from(schema.buildJobs)
        .where(eq(schema.buildJobs.buildId, first.buildId));
      expect(job?.input.skillsV1?.skills[0]?.versionId).toBe(
        original.versionId,
      );
      const publicBuild = await getOwnedBuild(db, first.buildId, actor);
      expect(publicBuild?.skillsUsed).toEqual([
        {
          name: "clear-copy",
          versionId: original.versionId,
          sha256: job!.input.skillsV1!.skills[0]!.sha256,
        },
      ]);
      expect(JSON.stringify(publicBuild)).not.toContain(document);

      await changeSkill(db, actor, body.skillId, {
        kind: "archive",
        requestId: crypto.randomUUID(),
        expectedRevision: original.currentRevision,
        archived: true,
      });
      await db
        .update(schema.buildJobs)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(schema.buildJobs.buildId, first.buildId));
      await db
        .update(schema.builds)
        .set({ status: "failed", files: [], errorMessage: "Fixture failure" })
        .where(eq(schema.builds.id, first.buildId));
      const replacement = await createSkill(db, actor, input());
      const state = await readProjectSkills(db, projectId, actor);
      await changeProjectSkills(db, projectId, actor, {
        requestId: crypto.randomUUID(),
        expectedRevision: state.revision,
        versionIds: [replacement.versionId],
      });
      const retry = await admitBuild(
        { projectId, retryBuildId: first.buildId },
        actor,
        crypto.randomUUID(),
        dependencies,
      );
      const [retried] = await db
        .select()
        .from(schema.buildJobs)
        .where(eq(schema.buildJobs.buildId, retry.buildId));
      expect(retried?.input.skillsV1).toEqual(job?.input.skillsV1);
      expect(retried?.input.skillsV1?.skills[0]?.versionId).not.toBe(
        replacement.versionId,
      );
      await db
        .update(schema.buildJobs)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(schema.buildJobs.buildId, retry.buildId));
      await db
        .update(schema.builds)
        .set({ status: "failed", files: [] })
        .where(eq(schema.builds.id, retry.buildId));
    });
  test("Plan and atomic Auto actions consume admitted snapshots after library edits/archive", async () => {
    const dependencies = {
      db,
      defaultModel: "fixture",
      resolveProvider: () => ({ id: "fixture" }),
    };
    for (const mode of ["plan", "auto"] as const) {
      const body = input(),
        saved = await createSkill(db, actor, body),
        projectId = crypto.randomUUID();
      await db.insert(schema.projects).values({
        id: projectId,
        userId: actor,
        name: "Guided conversation",
        stack: "nextjs",
      });
      const initial = await readProjectSkills(db, projectId, actor);
      await changeProjectSkills(db, projectId, actor, {
        requestId: crypto.randomUUID(),
        expectedRevision: initial.revision,
        versionIds: [saved.versionId],
      });
      const admitted = await admitConversationTurn(
        projectId,
        actor,
        crypto.randomUUID(),
        { message: "Build a directory", mode },
        dependencies,
      );
      const claim = await claimConversationTurn(db);
      if (!claim || claim.turnId !== admitted.turnId)
        throw new Error("Expected admitted fixture claim");
      await changeSkill(db, actor, body.skillId, {
        kind: "archive",
        requestId: crypto.randomUUID(),
        expectedRevision: saved.currentRevision,
        archived: true,
      });
      const context = await loadConversationContext(db, claim);
      expect(context.skillsV1?.skills[0]?.document).toBe(document);
      if (mode === "plan") {
        let calls = 0;
        await expect(
          inferConversationDecision(
            { context, model: "fixture", mode },
            { baseUrl: "http://fixture.test/v1", apiKey: "fixture" },
            new AbortController().signal,
            async (_url, init) => {
              calls++;
              const payload = JSON.parse(String(init.body)) as {
                messages: Array<{ content: string }>;
              };
              expect(payload.messages[0]?.content).toContain(
                "subordinate to all system",
              );
              expect(payload.messages[1]?.content).toContain(saved.versionId);
              return Response.json({
                choices: [
                  {
                    finish_reason: "stop",
                    message: {
                      content: JSON.stringify({
                        type: "propose_build",
                        content: "Plan",
                        prompt: "Build",
                      }),
                    },
                  },
                ],
              });
            },
          ),
        ).rejects.toThrow();
        expect(calls).toBe(1);
        const history = await getConversationHistory(db, projectId, actor);
        expect(history.latestTurn?.skillsUsed?.[0]?.versionId).toBe(
          saved.versionId,
        );
        expect(JSON.stringify(history)).not.toContain(document);

        await completeConversationAnswer(db, claim, {
          type: "answer",
          content: "Reviewed plan",
        });
        expect(
          await db
            .select()
            .from(schema.builds)
            .where(eq(schema.builds.projectId, projectId)),
        ).toHaveLength(0);
        await expect(
          admitConversationTurn(
            projectId,
            actor,
            crypto.randomUUID(),
            { message: "Another request", mode },
            dependencies,
          ),
        ).rejects.toMatchObject({ status: 409 });
      } else {
        const buildId = await admitConversationBuildAction(
          db,
          claim,
          {
            type: "propose_build",
            content: "Build the reviewed directory",
            prompt: "Build the directory",
          },
          dependencies,
        );
        const [job] = await db
          .select()
          .from(schema.buildJobs)
          .where(eq(schema.buildJobs.buildId, buildId));
        expect(job?.input.skillsV1).toEqual(claim.input.skillsV1);
        expect(job?.input.skillsV1?.skills[0]?.versionId).toBe(saved.versionId);
      }
    }
  });
  test("library quota is serialized and includes archived identities", async () => {
    const heads = Array.from({ length: 100 }, () => ({
      id: crypto.randomUUID(),
      ownerId: quotaActor,
      revision: crypto.randomUUID(),
      currentVersionId: crypto.randomUUID(),
      archivedAt: new Date(),
    }));
    await db.insert(schema.skills).values(heads);
    await db.insert(schema.skillVersions).values(
      heads.map((head) => ({
        id: head.currentVersionId,
        skillId: head.id,
        authorId: quotaActor,
        document,
        sha256: "fixture",
        name: "clear-copy",
        description: "Fixture",
        source: "authored" as const,
      })),
    );
    await expect(createSkill(db, quotaActor, input())).rejects.toMatchObject({
      status: 409,
    });
    expect(
      await db
        .select()
        .from(schema.skills)
        .where(and(eq(schema.skills.ownerId, quotaActor))),
    ).toHaveLength(100);
    const removed = heads[0]!;
    await db
      .delete(schema.skillVersions)
      .where(eq(schema.skillVersions.id, removed.currentVersionId));
    await db.delete(schema.skills).where(eq(schema.skills.id, removed.id));
    const competing = await Promise.allSettled([
      createSkill(db, quotaActor, input()),
      createSkill(db, quotaActor, input()),
    ]);
    expect(
      competing.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.skills)
        .where(eq(schema.skills.ownerId, quotaActor)),
    ).toHaveLength(100);
  });
});
