// Reads deployment history from a disposable database without contacting providers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  listDeploymentHistory,
  publicDeploymentUrl,
} from "../../../../../apps/api/src/modules/deployments/http/deployment-history";
const url = process.env.WRENLY_TEST_DEPLOYMENT_HISTORY_DATABASE_URL;
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    new URL(url).pathname !== "/wrenly_history_test")
)
  throw new Error("Use a disposable local wrenly_history_test database.");
const suite = url ? describe : describe.skip;
suite("authorized deployment history", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_history_test", {
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });
  const project = crypto.randomUUID(),
    build = crypto.randomUUID();
  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: new URL("../../../migrations", import.meta.url).pathname,
    });
    await database
      .insert(schema.user)
      .values(
        ["creator", "viewer", "admin"].map((id) => ({
          id,
          name: id,
          email: `${id}@fixture.test`,
        })),
      );
    await database
      .insert(schema.organization)
      .values({
        id: "instance",
        name: "fixture",
        slug: "fixture",
        createdAt: new Date(),
      });
    await database
      .insert(schema.instanceSetup)
      .values({
        id: 1,
        ownerId: "admin",
        organizationId: "instance",
        initializedAt: new Date(),
      });
    await database
      .insert(schema.member)
      .values(
        ["creator", "viewer", "admin"].map((id) => ({
          id,
          userId: id,
          organizationId: "instance",
          role: id === "admin" ? "owner" : "member",
          createdAt: new Date(),
        })),
      );
    await database
      .insert(schema.projects)
      .values({
        id: project,
        userId: "creator",
        name: "Shared project",
        accessMode: "selected",
        archivedAt: new Date(),
      });
    await database
      .insert(schema.projectMembers)
      .values({ projectId: project, userId: "viewer", role: "viewer" });
    await database
      .insert(schema.builds)
      .values({
        id: build,
        projectId: project,
        prompt: "private prompt",
        status: "success",
        files: [],
      });
    await database
      .insert(schema.deploymentResources)
      .values({
        projectId: project,
        gitInstanceUrl: "https://git.fixture.test",
        repositoryOwner: "fixture",
        repositoryName: "private",
        coolifyInstanceUrl: "https://coolify.fixture.test",
        coolifyProjectUuid: "private",
        coolifyServerUuid: "private",
        coolifyEnvironmentName: "production",
      });
    await database.insert(schema.deployments).values(
      Array.from({ length: 26 }, (_, index) => ({
        projectId: project,
        buildId: build,
        userId: "creator",
        idempotencyKey: crypto.randomUUID(),
        requestIdentity: `private-${index}`,
        stack: "nextjs" as const,
        files: [{ path: "private.txt", content: "private-source" }],
        sourceSha256: "a".repeat(64),
        status: "success" as const,
        url: index === 25 ? "javascript:alert(1)" : "https://app.fixture.test",
        createdAt: new Date(1000000 + index),
      })),
    );
  });
  afterAll(async () => {
    await client.end();
  });
  test("bounded ordered pages expose only safe columns and preserve archived history", async () => {
    const first = await listDeploymentHistory(database, "viewer", 0);
    expect(first.deployments.length).toBe(24);
    expect(first.nextOffset).toBe(24);
    expect(first.deployments[0]?.url).toBeNull();
    expect(Object.keys(first.deployments[0]!).sort()).toEqual(
      [
        "id",
        "projectId",
        "projectName",
        "buildId",
        "stack",
        "status",
        "createdAt",
        "url",
      ].sort(),
    );
    expect(JSON.stringify(first)).not.toContain("private-source");
    const next = await listDeploymentHistory(database, "viewer", 24);
    expect(next.deployments.length).toBe(2);
    expect(next.nextOffset).toBeNull();
    expect(
      new Set([...first.deployments, ...next.deployments].map((row) => row.id))
        .size,
    ).toBe(26);
    expect(
      (await listDeploymentHistory(database, "admin", 0)).deployments,
    ).toEqual([]);
  });
  test("revoking project access and suspending accounts removes history on the next read", async () => {
    await database
      .delete(schema.projectMembers)
      .where(eq(schema.projectMembers.userId, "viewer"));
    expect(
      (await listDeploymentHistory(database, "viewer", 0)).deployments,
    ).toEqual([]);
    await database
      .update(schema.projects)
      .set({ accessMode: "instance" })
      .where(eq(schema.projects.id, project));
    expect(
      (await listDeploymentHistory(database, "viewer", 0)).deployments.length,
    ).toBe(24);
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, "viewer"));
    await expect(
      listDeploymentHistory(database, "viewer", 0),
    ).rejects.toThrow();
    expect(
      (await listDeploymentHistory(database, "creator", 0)).deployments.length,
    ).toBe(24);
  });
});
test("history URL destinations reject credentials and executable schemes", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,hello",
    "https://secret:token@example.test",
    "/relative",
    null,
  ])
    expect(publicDeploymentUrl(value)).toBeNull();
  expect(publicDeploymentUrl("http://192.168.1.2:8000")).toBe(
    "http://192.168.1.2:8000/",
  );
});
