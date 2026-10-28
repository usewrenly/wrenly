// Tests saved draft metadata with a disposable database, without inference or external runtimes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  listDrafts,
  readDraft,
  mutateDraft,
  verifyDraftSchema,
  draftCandidates,
} from "../../../../../apps/api/src/modules/projects/drafts/draft-store";
import { createDraftHandlers } from "../../../../../apps/api/src/modules/projects/drafts/draft-http";
import { accessContext } from "../../../../../apps/api/src/modules/auth/access/access-context";
type DraftFixture = typeof schema.projectDrafts.$inferSelect & {
  capabilities: { role: string; contribute: boolean };
};
const url = process.env.WRENLY_TEST_DRAFT_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_drafts_test"
  )
    throw new Error("Use only a disposable local wrenly_drafts_test database.");
}
const suite = url ? describe : describe.skip;
suite("persistent project drafts", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_drafts_test", {
      onnotice: () => {},
    }),
    database = drizzle(client, { schema });
  const id = crypto.randomUUID(),
    create = {
      draftId: id,
      requestId: crypto.randomUUID(),
      title: "An idea at the shops",
      body: "A rough idea worth discussing.",
    };
  let revision = "";
  const decoded = (
    value: unknown,
  ): { draft: DraftFixture; savedRevision: string; replayed: boolean } =>
    value as { draft: DraftFixture; savedRevision: string; replayed: boolean };
  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: new URL("../../../migrations", import.meta.url).pathname,
    });
    await verifyDraftSchema(database);
    await database.insert(schema.user).values(
      [
        "owner",
        "editor",
        "viewer",
        "stranger",
        "admin",
        "pending",
        "banned",
      ].map((id) => ({
        id,
        name: id,
        email: `${id}@example.test`,
        banned: id === "banned",
      })),
    );
    await database.insert(schema.organization).values({
      id: "instance",
      name: "Draft fixture",
      slug: "draft-fixture",
      createdAt: new Date(),
    });
    await database.insert(schema.instanceSetup).values({
      id: 1,
      ownerId: "admin",
      organizationId: "instance",
      initializedAt: new Date(),
    });
    await database.insert(schema.member).values(
      ["owner", "editor", "viewer", "admin", "banned"].map((id) => ({
        id,
        userId: id,
        organizationId: "instance",
        role: id === "admin" ? "owner" : "member",
        createdAt: new Date(),
      })),
    );
  });
  afterAll(async () => {
    await client.end();
  });
  test("create is private, bounded and replayable without creating another draft", async () => {
    const saved = decoded(await mutateDraft(database, "owner", create));
    revision = saved.draft.revision;
    expect(saved.draft.accessMode).toBe("private");
    expect(saved.draft.body).toBe(create.body);
    const replay = decoded(await mutateDraft(database, "owner", create));
    expect(replay.replayed).toBe(true);
    expect(replay.savedRevision).toBe(revision);
    await expect(
      mutateDraft(database, "owner", { ...create, title: "Different" }),
    ).rejects.toThrow("another draft change");
    await expect(
      mutateDraft(database, "owner", {
        ...create,
        requestId: crypto.randomUUID(),
        body: "a".repeat(50001),
      }),
    ).rejects.toThrow("Review the draft fields");
    const rows = await database.select().from(schema.projectDrafts);
    expect(rows).toHaveLength(1);
  });
  test("private content and directory deny members and instance administrator", async () => {
    for (const actor of [
      "editor",
      "viewer",
      "stranger",
      "admin",
      "pending",
      "banned",
    ])
      await expect(readDraft(database, id, actor)).rejects.toThrow();
    expect(
      ((await listDrafts(database, "admin")) as { drafts: unknown[] }).drafts,
    ).toHaveLength(0);
    await expect(draftCandidates(database, id, "admin")).rejects.toThrow();
    const candidates = (await draftCandidates(
      database,
      id,
      "owner",
      "edit",
    )) as { members: Array<{ userId: string }> };
    expect(candidates.members.map((person) => person.userId)).toEqual([
      "editor",
    ]);
    await expect(
      mutateDraft(database, "pending", {
        ...create,
        draftId: crypto.randomUUID(),
        requestId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("Join this instance");
  });
  test("explicit accepted grants enforce Viewer and Editor without owner impersonation", async () => {
    const changed = decoded(
      await mutateDraft(
        database,
        "owner",
        {
          kind: "sharing",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          mode: "selected",
          instanceRole: "viewer",
          members: [
            { userId: "editor", role: "editor" },
            { userId: "viewer", role: "viewer" },
          ],
        },
        id,
      ),
    );
    revision = changed.draft.revision;
    expect(
      ((await readDraft(database, id, "viewer")) as DraftFixture).capabilities
        .contribute,
    ).toBe(false);
    await expect(
      mutateDraft(
        database,
        "viewer",
        {
          kind: "content",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          title: "No",
          body: "No",
        },
        id,
      ),
    ).rejects.toThrow("role");
    const edit = decoded(
      await mutateDraft(
        database,
        "editor",
        {
          kind: "content",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          title: create.title,
          body: "Refined together",
        },
        id,
      ),
    );
    revision = edit.draft.revision;
    expect(edit.draft.updatedBy).toBe("editor");
    expect(edit.draft.ownerId).toBe("owner");
    await expect(draftCandidates(database, id, "editor")).rejects.toThrow(
      "Only the draft owner",
    );
    await expect(
      mutateDraft(
        database,
        "editor",
        {
          kind: "archive",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          archived: true,
        },
        id,
      ),
    ).rejects.toThrow("role");
  });
  test("stale/concurrent saves never overwrite another saved revision", async () => {
    const input = {
      kind: "content" as const,
      requestId: crypto.randomUUID(),
      expectedRevision: revision,
      title: create.title,
      body: "Version A",
    };
    const result = decoded(await mutateDraft(database, "editor", input, id));
    revision = result.draft.revision;
    await expect(
      mutateDraft(
        database,
        "editor",
        { ...input, requestId: crypto.randomUUID(), body: "Version B" },
        id,
      ),
    ).rejects.toThrow("changed elsewhere");
    expect(
      decoded(await mutateDraft(database, "editor", input, id)).replayed,
    ).toBe(true);
    const concurrent = await Promise.allSettled(
      ["C", "D"].map((body) =>
        mutateDraft(
          database,
          "editor",
          {
            ...input,
            requestId: crypto.randomUUID(),
            expectedRevision: revision,
            body,
          },
          id,
        ),
      ),
    );
    expect(
      concurrent.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const current = (await readDraft(database, id, "owner")) as DraftFixture;
    revision = current.revision;
    expect(["C", "D"]).toContain(current.body);
  });
  test("sharing validates accepted active members and stale sessions fail closed", async () => {
    for (const actor of ["pending", "stranger", "banned"])
      await expect(
        mutateDraft(
          database,
          "owner",
          {
            kind: "sharing",
            requestId: crypto.randomUUID(),
            expectedRevision: revision,
            mode: "selected",
            instanceRole: "viewer",
            members: [{ userId: actor, role: "editor" }],
          },
          id,
        ),
      ).rejects.toThrow("accepted, active");
    await expect(
      accessContext.run(
        {
          principal: {
            userId: "owner",
            sessionId: "missing",
            revision: crypto.randomUUID(),
          },
        },
        () => readDraft(database, id, "owner"),
      ),
    ).rejects.toThrow("access has changed");
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, "editor"));
    await expect(readDraft(database, id, "editor")).rejects.toThrow(
      "access has changed",
    );
    await database
      .update(schema.user)
      .set({ banned: false })
      .where(eq(schema.user.id, "editor"));
  });
  test("Everyone uses current membership; access reduction removes reads and lists", async () => {
    let changed = decoded(
      await mutateDraft(
        database,
        "owner",
        {
          kind: "sharing",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          mode: "instance",
          instanceRole: "viewer",
          members: [],
        },
        id,
      ),
    );
    revision = changed.draft.revision;
    expect(
      ((await readDraft(database, id, "admin")) as DraftFixture).capabilities
        .role,
    ).toBe("viewer");
    await expect(readDraft(database, id, "pending")).rejects.toThrow(
      "not found",
    );
    changed = decoded(
      await mutateDraft(
        database,
        "owner",
        {
          kind: "sharing",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          mode: "private",
          instanceRole: "viewer",
          members: [],
        },
        id,
      ),
    );
    revision = changed.draft.revision;
    await expect(readDraft(database, id, "editor")).rejects.toThrow(
      "not found",
    );
    expect(
      ((await listDrafts(database, "editor")) as { drafts: unknown[] }).drafts,
    ).toHaveLength(0);
  });
  test("draft archive is reversible and prevents content edits, without execution", async () => {
    const archived = decoded(
      await mutateDraft(
        database,
        "owner",
        {
          kind: "archive",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          archived: true,
        },
        id,
      ),
    );
    revision = archived.draft.revision;
    expect(archived.draft.archivedAt).not.toBeNull();
    await expect(
      mutateDraft(
        database,
        "owner",
        {
          kind: "content",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          title: "No",
          body: "No",
        },
        id,
      ),
    ).rejects.toThrow("Restore this draft");
    const restored = decoded(
      await mutateDraft(
        database,
        "owner",
        {
          kind: "archive",
          requestId: crypto.randomUUID(),
          expectedRevision: revision,
          archived: false,
        },
        id,
      ),
    );
    revision = restored.draft.revision;
    expect(restored.draft.archivedAt).toBeNull();
    expect(await database.select().from(schema.projects)).toHaveLength(0);
    expect(await database.select().from(schema.builds)).toHaveLength(0);
  });
  test("HTTP authenticates before bounded JSON and enforces exact origin", async () => {
    const http = createDraftHandlers(database, {
      webUrl: "http://localhost:3000",
      userId: async (headers) => headers.get("x-fixture-user"),
    });
    const request = (
      body: string,
      origin = "http://localhost:3000",
      actor = "owner",
    ): Request =>
      new Request("http://localhost/api/drafts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "x-fixture-user": actor,
        },
        body,
      });
    expect(
      (await http.create(request("bad", "http://evil.test", ""))).status,
    ).toBe(401);
    expect(
      (await http.create(request(JSON.stringify(create), "http://evil.test")))
        .status,
    ).toBe(403);
    expect((await http.create(request("x".repeat(256001)))).status).toBe(400);
    expect((await http.create(request("bad"))).status).toBe(400);
    const replay = await http.create(request(JSON.stringify(create)));
    expect(replay.status).toBe(200);
    expect(replay.headers.get("cache-control")).toContain("no-store");
    expect(
      (
        await http.get(
          new Request("http://localhost/api", {
            headers: { "x-fixture-user": "stranger" },
          }),
          id,
        )
      ).status,
    ).toBe(404);
  });
});
