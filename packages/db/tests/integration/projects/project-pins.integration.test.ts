// Exercises per-user project pinning, pinned-first sorting, workspace collaborator avatars, and co-member picture access against a dedicated disposable database.
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
import * as schema from "../../../src/schema";
import {
  MAX_PINNED_PROJECTS,
  setProjectPin,
} from "../../../../../apps/api/src/modules/projects/pins/project-pins";
import { listProjects } from "../../../../../apps/api/src/modules/projects/http/projects";
import { getProject } from "../../../../../apps/api/src/modules/projects/http/project";
import { readProfilePicture } from "../../../../../apps/api/src/modules/auth/profile/pictures/profile-picture-store";

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

integration("project pinning and workspace collaborator avatars", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_project_test", {
    onnotice: () => {},
  });
  const database = drizzle(client, { schema });

  beforeAll(async () => {
    await migrate(database, {
      migrationsFolder: `${import.meta.dir}/../../../migrations`,
    });
  });

  afterEach(async () => {
    await database.delete(schema.projectPins);
    await database.delete(schema.projectMembers);
    await database.delete(schema.projects);
    await database.delete(schema.profilePictures);
    await database.delete(schema.member);
    await database.delete(schema.instanceSetup);
    await database.delete(schema.organization);
    await database.delete(schema.user);
  });

  afterAll(async () => {
    await client.end();
  });

  async function seedCollaborationFixture() {
    await database.insert(schema.user).values([
      { id: "owner", name: "Owner User", email: "owner@example.test" },
      { id: "collab", name: "Alice Editor", email: "alice@example.test" },
      { id: "outsider", name: "Outsider User", email: "outsider@example.test" },
    ]);
    const createdAt = new Date();
    await database.insert(schema.organization).values({
      id: "org-1",
      name: "Wrenly Instance",
      slug: "wrenly-instance",
      createdAt,
    });
    await database.insert(schema.instanceSetup).values({
      id: 1,
      ownerId: "owner",
      organizationId: "org-1",
      initializedAt: createdAt,
    });
    await database.insert(schema.member).values([
      { id: "m-owner", organizationId: "org-1", userId: "owner", role: "owner", createdAt },
      { id: "m-collab", organizationId: "org-1", userId: "collab", role: "member", createdAt },
      { id: "m-outsider", organizationId: "org-1", userId: "outsider", role: "member", createdAt },
    ]);
    const pictureRevision = crypto.randomUUID();
    await database.insert(schema.profilePictures).values({
      userId: "owner",
      revision: pictureRevision,
      mutationId: crypto.randomUUID(),
      expectedRevision: null,
      imageBase64: Buffer.from("owner-png-bytes").toString("base64"),
      contentHash: "a".repeat(64),
    });

    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    const [olderProject, newerSharedProject] = await database
      .insert(schema.projects)
      .values([
        {
          userId: "owner",
          name: "Older Private Project",
          stack: "nextjs",
          accessMode: "private",
          updatedAt: older,
        },
        {
          userId: "owner",
          name: "Newer Shared Project",
          stack: "laravel",
          accessMode: "selected",
          updatedAt: newer,
        },
      ])
      .returning();

    await database.insert(schema.projectMembers).values({
      projectId: newerSharedProject!.id,
      userId: "collab",
      role: "editor",
    });

    return {
      olderProject: olderProject!,
      newerSharedProject: newerSharedProject!,
      pictureRevision,
    };
  }

  test("pins are scoped per user, ordered first in collection listings, and enforce authorization and limit", async () => {
    const { olderProject, newerSharedProject } =
      await seedCollaborationFixture();

    await expect(
      setProjectPin(database, olderProject.id, "outsider", true),
    ).rejects.toThrow("not found");

    const ownerPinned = await setProjectPin(
      database,
      olderProject.id,
      "owner",
      true,
    );
    expect(ownerPinned.pinned).toBe(true);
    expect(ownerPinned.pinnedAt).toBeTruthy();

    await setProjectPin(database, newerSharedProject.id, "collab", true);

    const ownerListRes = await listProjects(
      new Request("http://localhost:3002/api/projects"),
      { database, session: async () => "owner" },
    );
    const ownerList = (await ownerListRes.json()) as {
      projects: Array<{ id: string; pinnedAt: string | null }>;
    };
    expect(ownerList.projects.map((p) => p.id)).toEqual([
      olderProject.id,
      newerSharedProject.id,
    ]);
    expect(ownerList.projects[0]?.pinnedAt).toBeTruthy();
    expect(ownerList.projects[1]?.pinnedAt).toBeNull();

    await setProjectPin(database, olderProject.id, "owner", false);

    // Enforces MAX_PINNED_PROJECTS per user.
    const extraProjects = await database
      .insert(schema.projects)
      .values(
        Array.from({ length: MAX_PINNED_PROJECTS + 1 }, (_, index) => ({
          userId: "owner",
          name: `Extra ${index}`,
          stack: "nextjs" as const,
        })),
      )
      .returning();
    for (const project of extraProjects.slice(0, MAX_PINNED_PROJECTS)) {
      await setProjectPin(database, project.id, "owner", true);
    }
    await expect(
      setProjectPin(database, extraProjects[MAX_PINNED_PROJECTS]!.id, "owner", true),
    ).rejects.toThrow("up to 20");
  });

  test("shared project returns bounded collaborators and grants co-members picture visibility", async () => {
    const { olderProject, newerSharedProject, pictureRevision } =
      await seedCollaborationFixture();

    const privateRes = await getProject(
      new Request(`http://localhost:3002/api/projects/${olderProject.id}`),
      olderProject.id,
      { database, session: async () => "owner" },
    );
    const privatePayload = (await privateRes.json()) as {
      pinned: boolean;
      collaborators: unknown[];
      collaboratorCount: number;
    };
    expect(privatePayload.collaborators).toEqual([]);
    expect(privatePayload.collaboratorCount).toBe(0);

    const sharedRes = await getProject(
      new Request(`http://localhost:3002/api/projects/${newerSharedProject.id}`),
      newerSharedProject.id,
      { database, session: async () => "collab" },
    );
    const sharedPayload = (await sharedRes.json()) as {
      collaborators: Array<{
        id: string;
        name: string;
        role: string;
        pictureUrl: string | null;
      }>;
      collaboratorCount: number;
    };
    expect(sharedPayload.collaboratorCount).toBe(2);
    expect(sharedPayload.collaborators.map((c) => `${c.id}:${c.role}`)).toEqual([
      "owner:owner",
      "collab:editor",
    ]);
    expect(JSON.stringify(sharedPayload.collaborators)).not.toContain(
      "@example.test",
    );
    expect(sharedPayload.collaborators[0]?.pictureUrl).toContain(
      `revision=${pictureRevision}`,
    );

    const collabBytes = await readProfilePicture(
      database,
      "collab",
      "owner",
      pictureRevision,
    );
    expect(Buffer.from(collabBytes).toString("utf8")).toBe("owner-png-bytes");

    await expect(
      readProfilePicture(database, "outsider", "owner", pictureRevision),
    ).rejects.toThrow("Picture unavailable");
  });
});
