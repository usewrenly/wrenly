/** Disposable control PostgreSQL verifies coordination only; fixture receipts never stand for native SQL acceptance. */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "../../../src/schema";
import {
  saveDatabaseProposal,
  approveDatabaseWorkflow,
  readDatabaseWorkflows,
} from "../../../../../apps/api/src/modules/conversations/database-workflow/store";
import { reconcileDatabaseWorkflows } from "../../../../../apps/api/src/modules/conversations/database-workflow/worker";
import {
  admitConversationTurn,
  claimConversationTurn,
} from "../../../../../apps/api/src/modules/conversations/persistence/conversation-store";
import { reconcileConversationBuild } from "../../../../../apps/api/src/modules/conversations/execution/conversation-actions";
import { accessContext } from "../../../../../apps/api/src/modules/auth/access/access-context";
import { readAppDatabaseManifest } from "../../../../sandbox/src/databases/database-manifest";
const url = process.env.WRENLY_TEST_CONVERSATION_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_conversation_database_test"
  )
    throw new Error("Use only the disposable conversation database fixture.");
}
const integration = url ? describe : describe.skip;
integration("conversation-led database approvals", () => {
  const client = postgres(
    url ?? "postgresql://localhost/wrenly_conversation_database_test",
  );
  const db = drizzle(client, { schema });
  const owner = `workflow-${crypto.randomUUID()}`,
    other = `other-${crypto.randomUUID()}`,
    sessionId = crypto.randomUUID(),
    accessRevision = crypto.randomUUID();
  const principal = { userId: owner, sessionId, revision: accessRevision };
  const settings = {
    defaultModel: "frozen-model",
    resolveProvider: () => ({ id: "frozen-provider" }),
  };
  let directory: string;
  const decision = {
    type: "propose_database" as const,
    content: "This notes app needs persistent storage.",
    prompt: "Build a notes app with persistent PostgreSQL records.",
  };
  const files = [
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
      content: "CREATE TABLE notes(id integer PRIMARY KEY);",
    },
    {
      path: "drizzle/meta/_journal.json",
      content: JSON.stringify({
        dialect: "postgresql",
        entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }],
      }),
    },
  ];
  const cycle = (): Promise<void> =>
    reconcileDatabaseWorkflows(db, { directory, build: settings });
  async function fixture(
    mode: "auto" | "plan" = "auto",
  ): Promise<typeof schema.conversationDatabaseWorkflows.$inferSelect> {
    const projectId = crypto.randomUUID();
    await db
      .insert(schema.projects)
      .values({ id: projectId, userId: owner, name: "Notes workflow" });
    await admitConversationTurn(
      projectId,
      owner,
      crypto.randomUUID(),
      { message: "Build persistent notes", mode },
      { db, ...settings },
    );
    const claim = await claimConversationTurn(db);
    if (!claim) throw new Error("Missing claim");
    if (mode === "plan") {
      await expect(saveDatabaseProposal(db, claim, decision)).rejects.toThrow(
        "Plan mode",
      );
      throw new Error("Plan fixture only");
    }
    await saveDatabaseProposal(db, claim, decision);
    const [row] = await db
      .select()
      .from(schema.conversationDatabaseWorkflows)
      .where(eq(schema.conversationDatabaseWorkflows.projectId, projectId));
    return row!;
  }
  beforeAll(async () => {
    await migrate(db, {
      migrationsFolder: `${import.meta.dir}/../../../migrations`,
    });
    directory = await mkdtemp(join(tmpdir(), "wrenly-chat-database-"));
    await db.insert(schema.user).values([
      {
        id: owner,
        name: "Owner",
        email: `${owner}@example.test`,
        accessRevision,
      },
      { id: other, name: "Other", email: `${other}@example.test` },
    ]);
    await db.insert(schema.session).values({
      id: sessionId,
      userId: owner,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
      accessRevision,
    });
  });
  afterAll(async () => {
    await client.end();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  test("proposal is inert; one explicit approval survives duplicate clicks and repeated polling", async () => {
    const row = await fixture();
    expect(
      await db
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.projectId, row.projectId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.buildJobs)
        .where(eq(schema.buildJobs.projectId, row.projectId)),
    ).toHaveLength(0);
    const safe = JSON.stringify(
      await readDatabaseWorkflows(db, row.projectId, owner),
    );
    expect(safe).not.toContain(sessionId);
    expect(safe).not.toContain("frozen-model");
    await expect(
      approveDatabaseWorkflow(db, row.projectId, other, row.id, {
        revision: row.revision,
        decision: "approve",
      }),
    ).rejects.toThrow();
    await accessContext.run({ principal }, async () => {
      await approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: row.revision,
        decision: "approve",
      });
      await approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: row.revision,
        decision: "approve",
      });
    });
    await Promise.all([cycle(), cycle(), cycle()]);
    const ops = await db
      .select()
      .from(schema.appDatabaseOperations)
      .where(eq(schema.appDatabaseOperations.projectId, row.projectId));
    expect(ops).toHaveLength(1);
    expect(ops[0]!.kind).toBe("create");
    const operation = ops[0]!,
      resourceId = operation.databaseId;
    await db
      .update(schema.appDatabaseOperations)
      .set({ status: "success", completedAt: new Date() })
      .where(eq(schema.appDatabaseOperations.id, operation.id));
    await db
      .update(schema.appDatabases)
      .set({
        status: "ready",
        revision: crypto.randomUUID(),
        schemaDigest: "a".repeat(64),
      })
      .where(eq(schema.appDatabases.id, resourceId));
    await cycle();
    await cycle();
    await cycle();
    const jobs = await db
      .select()
      .from(schema.buildJobs)
      .where(eq(schema.buildJobs.projectId, row.projectId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.input.databaseV1?.resourceId).toBe(resourceId);
    expect(jobs[0]!.input.model).toBe("frozen-model");
    await db
      .update(schema.builds)
      .set({ status: "success", files })
      .where(eq(schema.builds.id, jobs[0]!.buildId));
    await db
      .update(schema.buildJobs)
      .set({ status: "success", completedAt: new Date() })
      .where(eq(schema.buildJobs.buildId, jobs[0]!.buildId));
    await reconcileConversationBuild(db);
    await cycle();
    const [review] = await db
      .select()
      .from(schema.conversationDatabaseWorkflows)
      .where(eq(schema.conversationDatabaseWorkflows.id, row.id));
    expect(review!.state).toBe("review");
    expect(review!.review?.files.length).toBeGreaterThan(0);
    // Setup approval must not grant authority for later saved-table changes.
    expect(
      await db
        .select()
        .from(schema.appDatabaseOperations)
        .where(
          and(
            eq(schema.appDatabaseOperations.projectId, row.projectId),
            eq(schema.appDatabaseOperations.kind, "migrate"),
          ),
        ),
    ).toHaveLength(0);
    await expect(
      accessContext.run({ principal }, () =>
        approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
          revision: row.revision,
          decision: "approve",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await accessContext.run({ principal }, () =>
      approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: review!.revision,
        decision: "approve",
      }),
    );
    await cycle();
    const [backupOp] = await db
      .select()
      .from(schema.appDatabaseOperations)
      .where(
        and(
          eq(schema.appDatabaseOperations.projectId, row.projectId),
          eq(schema.appDatabaseOperations.kind, "backup"),
        ),
      );
    expect(backupOp).toBeDefined();
    const backupId = crypto.randomUUID();
    await db
      .update(schema.appDatabaseOperations)
      .set({ status: "success", completedAt: new Date() })
      .where(eq(schema.appDatabaseOperations.id, backupOp!.id));
    await db.insert(schema.appDatabaseBackups).values({
      id: backupId,
      databaseId: resourceId,
      operationId: backupOp!.id,
      schemaDigest: "a".repeat(64),
      sha256: "b".repeat(64),
      encryptedPath: "fixture-only",
      verifiedAt: new Date(),
    });
    await cycle();
    await cycle();
    await cycle();
    const migrations = await db
      .select()
      .from(schema.appDatabaseOperations)
      .where(
        and(
          eq(schema.appDatabaseOperations.projectId, row.projectId),
          eq(schema.appDatabaseOperations.kind, "migrate"),
        ),
      );
    expect(migrations).toHaveLength(1);
    expect(migrations[0]!.migrationDigest).toBe(
      readAppDatabaseManifest(files, "nextjs")!.digest,
    );
    // The trusted database executor owns rehearsal/live SQL. This fixture only confirms its receipt.
    await db
      .update(schema.appDatabaseOperations)
      .set({ status: "success", completedAt: new Date() })
      .where(eq(schema.appDatabaseOperations.id, migrations[0]!.id));
    await db
      .update(schema.appDatabaseMigrations)
      .set({ rehearsedSchemaDigest: "c".repeat(64), completedAt: new Date() })
      .where(eq(schema.appDatabaseMigrations.operationId, migrations[0]!.id));
    await db
      .update(schema.appDatabases)
      .set({ schemaDigest: "c".repeat(64), revision: crypto.randomUUID() })
      .where(eq(schema.appDatabases.id, resourceId));
    await cycle();
    const [done] = await db
      .select()
      .from(schema.conversationDatabaseWorkflows)
      .where(eq(schema.conversationDatabaseWorkflows.id, row.id));
    expect(done!.state).toBe("complete");
    expect(
      await db
        .select()
        .from(schema.buildJobs)
        .where(eq(schema.buildJobs.projectId, row.projectId)),
    ).toHaveLength(1);
  });
  test("decline creates no operation and Plan cannot save an executable proposal", async () => {
    const row = await fixture();
    await accessContext.run({ principal }, () =>
      approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: row.revision,
        decision: "decline",
      }),
    );
    await cycle();
    expect(
      await db
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.projectId, row.projectId)),
    ).toHaveLength(0);
    await expect(fixture("plan")).rejects.toThrow("Plan fixture only");
    // Terminate the deliberately rejected inference claim so later fixtures can run.
    await db
      .update(schema.conversationTurns)
      .set({ status: "failed", claimToken: null, leaseExpiresAt: null })
      .where(eq(schema.conversationTurns.status, "running"));
  });
  test("changed resource and project revisions reject stale approvals", async () => {
    const row = await fixture();
    await db
      .update(schema.projects)
      .set({ accessRevision: crypto.randomUUID() })
      .where(eq(schema.projects.id, row.projectId));
    await expect(
      accessContext.run({ principal }, () =>
        approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
          revision: row.revision,
          decision: "approve",
        }),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await cycle();
    expect(
      await db
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.projectId, row.projectId)),
    ).toHaveLength(0);
  });
  test("Stop prevents a queued continuation from admitting its next operation", async () => {
    const row = await fixture();
    await accessContext.run({ principal }, () =>
      approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: row.revision,
        decision: "approve",
      }),
    );
    await accessContext.run({ principal }, () =>
      approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: row.revision,
        decision: "stop",
      }),
    );
    await cycle();
    expect(
      await db
        .select()
        .from(schema.appDatabaseOperations)
        .where(eq(schema.appDatabaseOperations.projectId, row.projectId)),
    ).toHaveLength(0);
    const [stopped] = await db
      .select()
      .from(schema.conversationDatabaseWorkflows)
      .where(eq(schema.conversationDatabaseWorkflows.id, row.id));
    expect(stopped!.state).toBe("cancelled");
  });
  test("HTTP requires a session, trusted origin and strict decision body", async () => {
    const { createDatabaseWorkflowHandlers } =
      await import("../../../../../apps/api/src/modules/conversations/database-workflow/http");
    const row = await fixture();
    const anonymous = createDatabaseWorkflowHandlers(
      db,
      async () => null,
      "http://localhost:3000",
    );
    expect(
      (
        await anonymous.read(
          new Request("http://localhost:3002/api"),
          row.projectId,
        )
      ).status,
    ).toBe(401);
    const handlers = createDatabaseWorkflowHandlers(
      db,
      async () => owner,
      "http://localhost:3000",
    );
    expect(
      (
        await handlers.approve(
          new Request("http://localhost:3002/api", {
            method: "POST",
            headers: { origin: "https://other.test" },
          }),
          row.projectId,
          row.id,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handlers.read(
          new Request("http://localhost:3002/api"),
          row.projectId,
        )
      ).status,
    ).toBe(200);
    const invalid = await accessContext.run({ principal }, () =>
      handlers.approve(
        new Request("http://localhost:3002/api", {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            revision: row.revision,
            decision: "approve",
            sql: "DELETE FROM notes",
          }),
        }),
        row.projectId,
        row.id,
      ),
    );
    expect(invalid.status).toBe(400);
    expect(
      await db
        .select()
        .from(schema.appDatabaseOperations)
        .where(eq(schema.appDatabaseOperations.projectId, row.projectId)),
    ).toHaveLength(0);
  });
  test("revoked approval session stops future setup without provisioning", async () => {
    const row = await fixture();
    await accessContext.run({ principal }, () =>
      approveDatabaseWorkflow(db, row.projectId, owner, row.id, {
        revision: row.revision,
        decision: "approve",
      }),
    );
    await db.delete(schema.session).where(eq(schema.session.id, sessionId));
    await cycle();
    const [blocked] = await db
      .select()
      .from(schema.conversationDatabaseWorkflows)
      .where(eq(schema.conversationDatabaseWorkflows.id, row.id));
    expect(blocked!.state).toBe("blocked");
    expect(
      await db
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.projectId, row.projectId)),
    ).toHaveLength(0);
  });
});
