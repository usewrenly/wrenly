// Exercises project settings only against a dedicated disposable database.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../../../src/schema";
import {
  readProjectSettings,
  saveProjectSettings,
} from "../../../../../apps/api/src/modules/projects/settings/project-settings";
import { ProjectSettingsInput } from "../../../../../apps/api/src/modules/projects/settings/settings-contract";
const url = process.env.WRENLY_TEST_PROJECT_DATABASE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    !["localhost", "127.0.0.1"].includes(parsed.hostname) ||
    parsed.pathname !== "/wrenly_project_test"
  )
    throw new Error(
      "Use only a disposable local wrenly_project_test database.",
    );
}
const integration = url ? describe : describe.skip;
integration("owned project settings persistence", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_project_test", {
      onnotice: () => {},
    }),
    database = drizzle(client, { schema });
  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: `${import.meta.dir}/../../../migrations`,
    });
  });
  afterEach(async () => {
    await database.delete(schema.user);
  });
  afterAll(async () => {
    await client.end();
  });
  async function fixture(): Promise<string> {
    await database.insert(schema.user).values([
      { id: "owner", name: "Owner", email: "owner@example.test" },
      { id: "other", name: "Other", email: "other@example.test" },
    ]);
    const [project] = await database
      .insert(schema.projects)
      .values({
        userId: "owner",
        name: "Original",
        stack: "nextjs",
        description: null,
      })
      .returning();
    return project!.id;
  }
  test("read/write scope ownership and expose no ownership identifiers", async () => {
    const id = await fixture();
    const details = await readProjectSettings(database, "owner", id);
    expect(details).toMatchObject({
      name: "Original",
      description: null,
      access: "private",
    });
    expect(JSON.stringify(details)).not.toContain("userId");
    await expect(readProjectSettings(database, "other", id)).rejects.toThrow(
      "Project not found",
    );
    await expect(
      saveProjectSettings(database, "other", id, {
        name: "Stolen",
        description: null,
        expected: { name: "Original", description: null },
      }),
    ).rejects.toThrow("Project not found");
    expect((await readProjectSettings(database, "owner", id)).name).toBe(
      "Original",
    );
  });
  test("concurrent differing writes against one snapshot yield one save and one conflict", async () => {
    const id = await fixture();
    const expected = { name: "Original", description: null };
    const results = await Promise.allSettled(
      ["First", "Second"].map((name) =>
        saveProjectSettings(database, "owner", id, {
          name,
          description: null,
          expected,
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected?.status === "rejected"
        ? (rejected.reason as { status: number }).status
        : 0,
    ).toBe(409);
    expect(["First", "Second"]).toContain(
      (await readProjectSettings(database, "owner", id)).name,
    );
  });
  test("lost acknowledgement replay confirms desired values and metadata activity does not cause false conflicts", async () => {
    const id = await fixture();
    await database
      .update(schema.projects)
      .set({ updatedAt: new Date("2025-01-01") })
      .where(eq(schema.projects.id, id));
    const change = ProjectSettingsInput.parse({
      name: " Revised ",
      description: "  ",
      expected: { name: "Original", description: null },
    });
    const first = await saveProjectSettings(database, "owner", id, change);
    const replay = await saveProjectSettings(database, "owner", id, change);
    expect(replay.name).toBe("Revised");
    expect(replay.description).toBeNull();
    expect(replay.updatedAt.getTime()).toBe(first.updatedAt.getTime());
    const [stored] = await database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, id));
    expect(stored?.userId).toBe("owner");
    expect(stored?.stack).toBe("nextjs");
    await saveProjectSettings(database, "owner", id, {
      name: "Revised",
      description: "A useful description",
      expected: { name: "Revised", description: null },
    });
    await expect(
      saveProjectSettings(database, "owner", id, {
        ...change,
        name: "Overwrite",
      }),
    ).rejects.toThrow("changed elsewhere");
  });
});
