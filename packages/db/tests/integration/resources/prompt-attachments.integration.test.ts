/** Only the explicitly named disposable local database is allowed; no instance data is used. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  saveAttachmentUpload,
  findAttachmentUpload,
  expireAttachmentUploads,
  attachmentCleanupCandidates,
  bindRequestAttachments,
  readAttachmentReference,
  removeAttachmentUpload,
} from "../../../../../apps/api/src/modules/attachments/attachment-store";
import {
  admitConversationTurn,
  claimConversationTurn,
} from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
const testUrl = process.env.WRENLY_TEST_ATTACHMENTS_DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  if (
    url.pathname !== "/wrenly_attachments_test" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new Error(
      "Attachment tests require a disposable local wrenly_attachments_test database.",
    );
}
const integration = testUrl ? describe : describe.skip;
integration("durable prompt attachment ownership", () => {
  const client = postgres(
    testUrl ?? "postgresql://localhost/wrenly_attachments_test",
  );
  const database = drizzle(client, { schema });
  const owner = `attachment-${crypto.randomUUID()}`;
  const other = `attachment-${crypto.randomUUID()}`;
  const projectId = crypto.randomUUID();
  const upload = () => ({
    requestId: crypto.randomUUID(),
    name: "reference.txt",
    mediaType: "text/plain" as const,
    object: { id: crypto.randomUUID(), sha256: "a".repeat(64), byteLength: 10 },
  });
  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: `${import.meta.dir}/../../../migrations`,
    });
    await database.insert(schema.user).values(
      [owner, other].map((id) => ({
        id,
        name: "Attachment fixture",
        email: `${id}@example.test`,
      })),
    );
    await database
      .insert(schema.projects)
      .values({ id: projectId, userId: owner, name: "Attachment fixture" });
  });
  afterAll(async () => {
    await database
      .delete(schema.conversations)
      .where(eq(schema.conversations.projectId, projectId));
    try {
      await database
        .delete(schema.promptAttachments)
        .where(inArray(schema.promptAttachments.ownerId, [owner, other]));
      await database
        .delete(schema.projects)
        .where(eq(schema.projects.id, projectId));
      await database
        .delete(schema.user)
        .where(inArray(schema.user.id, [owner, other]));
    } finally {
      await client.end();
    }
  });
  test("duplicate upload saves replay exact content and reject conflicting identities", async () => {
    const input = upload();
    const results = await Promise.all([
      saveAttachmentUpload(database, owner, input),
      saveAttachmentUpload(database, owner, input),
    ]);
    expect(results[0]?.file.id).toBe(results[1]?.file.id);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    await expect(
      saveAttachmentUpload(database, owner, { ...input, name: "changed.txt" }),
    ).rejects.toThrow();
    await expect(
      readAttachmentReference(database, other, results[0]!.file.id),
    ).rejects.toThrow();
  });
  test("admission binds exact references once and saved history cannot be removed", async () => {
    const saved = await saveAttachmentUpload(database, owner, upload());
    const requestId = crypto.randomUUID();
    const result = await database.transaction((tx) =>
      bindRequestAttachments(tx, owner, projectId, requestId, [saved.file.id]),
    );
    expect(result.files[0]?.sha256).toBe(saved.file.sha256);
    await expect(
      database.transaction((tx) =>
        bindRequestAttachments(tx, owner, projectId, crypto.randomUUID(), [
          saved.file.id,
        ]),
      ),
    ).rejects.toThrow();
    await expect(
      removeAttachmentUpload(database, owner, saved.file.id),
    ).rejects.toThrow();
    expect(
      (await readAttachmentReference(database, owner, saved.file.id)).id,
    ).toBe(saved.file.id);
  });
  test("expired and tombstoned uploads cannot bind, and failed multi-file binding is atomic", async () => {
    const first = await saveAttachmentUpload(database, owner, upload());
    const second = await saveAttachmentUpload(database, owner, upload());
    await database
      .update(schema.promptAttachments)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.promptAttachments.id, second.file.id));
    await expect(
      database.transaction((tx) =>
        bindRequestAttachments(tx, owner, projectId, crypto.randomUUID(), [
          first.file.id,
          second.file.id,
        ]),
      ),
    ).rejects.toThrow();
    const [unchanged] = await database
      .select()
      .from(schema.promptAttachments)
      .where(eq(schema.promptAttachments.id, first.file.id));
    expect(unchanged?.boundRequestId).toBeNull();
    await removeAttachmentUpload(database, owner, first.file.id);
    await expect(
      readAttachmentReference(database, owner, first.file.id),
    ).rejects.toThrow();
  });
  test("conversation admission freezes references and rejects unsupported capability without consuming files", async () => {
    const saved = await saveAttachmentUpload(database, owner, upload());
    const requestId = crypto.randomUUID();
    const body = {
      message: "Explain this reference",
      mode: "plan",
      attachmentIds: [saved.file.id],
    };
    const dependencies = {
      db: database,
      defaultModel: "fixture",
      resolveProvider: () => ({ id: "fixture" }),
    };
    await expect(
      admitConversationTurn(projectId, owner, requestId, body, dependencies),
    ).rejects.toThrow("not enabled");
    const [unused] = await database
      .select()
      .from(schema.promptAttachments)
      .where(eq(schema.promptAttachments.id, saved.file.id));
    expect(unused?.boundRequestId).toBeNull();
    let checked = false;
    const admitted = await admitConversationTurn(
      projectId,
      owner,
      requestId,
      body,
      {
        ...dependencies,
        validateAttachments: async (_tx, provider, model, snapshot) => {
          expect(provider).toBe("fixture");
          expect(model).toBe("fixture");
          expect(snapshot.files[0]?.id).toBe(saved.file.id);
          checked = true;
        },
      },
    );
    expect(checked).toBe(true);
    const claim = await claimConversationTurn(database);
    expect(claim?.turnId).toBe(admitted.turnId);
    expect(claim?.input.attachmentsV1?.files[0]?.sha256).toBe(
      saved.file.sha256,
    );
    const replay = await admitConversationTurn(
      projectId,
      owner,
      requestId,
      body,
      dependencies,
    );
    expect(replay.turnId).toBe(admitted.turnId);
  });
  test("upload acknowledgement lookup stays personal and expiry cleanup excludes retained history", async () => {
    const input = upload();
    const saved = await saveAttachmentUpload(database, owner, input);
    expect(
      (await findAttachmentUpload(database, owner, input.requestId))?.id,
    ).toBe(saved.file.id);
    expect(
      await findAttachmentUpload(database, other, input.requestId),
    ).toBeNull();
    await database
      .update(schema.promptAttachments)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.promptAttachments.id, saved.file.id));
    expect(
      await findAttachmentUpload(database, owner, input.requestId),
    ).toBeNull();
    const expiredObjects = await expireAttachmentUploads(database);
    expect(expiredObjects).toContain(saved.file.objectId);
    const candidates = await attachmentCleanupCandidates(database);
    expect(candidates.some((row) => row.objectId === saved.file.objectId)).toBe(
      true,
    );
    const retained = await database
      .select()
      .from(schema.promptAttachments)
      .where(
        eq(
          schema.promptAttachments.boundRequestId,
          (await database.select().from(schema.conversationTurns).limit(1))[0]!
            .id,
        ),
      );
    for (const row of retained)
      expect(
        candidates.some((candidate) => candidate.objectId === row.objectId),
      ).toBe(false);
  });
});
