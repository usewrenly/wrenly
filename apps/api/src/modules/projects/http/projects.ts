import { pinInitialProjectSkills } from "../../skills/project-skills";
import { SkillError } from "../../skills/skill-contract";
/**
 * Project collection and creation HTTP boundary.
 * Authenticates instance identity, filters collections by current project access and archive state, and creates projects under the active account.
 * Collection summaries omit build source/logs; creation never starts inference.
 */
import { ProjectInputError, readProjectInput } from "./project-input";

import { readableProjectPredicate } from "../access/project-access";
import { assertActiveAccount } from "../../auth/access/access-policy";
//
// GET  /api/projects — list the current user's projects
// POST /api/projects — create a new project

import { z } from "zod";
import { requireUserId } from "../../auth/access/session";
import { db } from "@wrenly/db";
import { projects, builds } from "@wrenly/db";
import { desc, inArray, and, isNull, isNotNull } from "drizzle-orm";

// ─── GET /api/projects ────────────────────────────────────────────────────────

export async function listProjects(
  request: Request,
  dependencies?: {
    database: typeof db;
    session: (headers: Headers) => Promise<string | null>;
  },
): Promise<Response> {
  const database = dependencies?.database ?? db;
  let userId: string;

  try {
    const identity = dependencies
      ? await dependencies.session(request.headers)
      : await requireUserId(request.headers);
    if (!identity) throw new Error("Unauthorized");
    userId = identity;
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const userProjects = await database
    .select()
    .from(projects)
    .where(
      and(
        readableProjectPredicate(database, userId),
        new URL(request.url).searchParams.get("archived") === "true"
          ? isNotNull(projects.archivedAt)
          : isNull(projects.archivedAt),
      ),
    )
    .orderBy(desc(projects.updatedAt));

  // Latest build per project — status pills, live URL and attempt counts on
  // the dashboard need it without shipping files/build logs (payload-heavy).
  const latestByProject = new Map<
    string,
    {
      id: string;
      status: string;
      attemptCount: number;
      deployedUrl: string | null;
      createdAt: Date;
    }
  >();

  if (userProjects.length > 0) {
    const projectIds = userProjects.map((p) => p.id);
    const recentBuilds = await database
      .select({
        id: builds.id,
        projectId: builds.projectId,
        status: builds.status,
        attemptCount: builds.attemptCount,
        deployedUrl: builds.deployedUrl,
        createdAt: builds.createdAt,
      })
      .from(builds)
      .where(inArray(builds.projectId, projectIds))
      .orderBy(desc(builds.createdAt));

    for (const build of recentBuilds) {
      // Ordered newest-first — first sighting of a project IS its latest.
      if (!latestByProject.has(build.projectId)) {
        latestByProject.set(build.projectId, build);
      }
    }
  }

  return Response.json({
    projects: userProjects.map((p) => ({
      ...p,
      owned: p.userId === userId,
      latestBuild: latestByProject.get(p.id) ?? null,
    })),
  });
}

// ─── POST /api/projects ───────────────────────────────────────────────────────

const CreateProjectSchema = z.object({
  name: z.string().min(1).max(100),
  stack: z.enum(["nextjs", "laravel", "vue", "django"]),
  description: z.string().max(500).optional(),
  skillVersionIds: z.array(z.string().uuid()).max(4).refine(ids => new Set(ids).size === ids.length).default([]),
});

export async function createProject(request: Request): Promise<Response> {
  let userId: string;

  try {
    userId = await requireUserId(request.headers);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await readProjectInput(request);
  } catch (error) {
    if (error instanceof ProjectInputError)
      return Response.json({ error: error.message }, { status: error.status });
    return Response.json(
      { error: "Project details could not be read." },
      { status: 400 },
    );
  }
  const parsed = CreateProjectSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  let project;
  try {
    project = await db.transaction(async (tx) => {
      await assertActiveAccount(tx, userId);
      const { skillVersionIds, ...details } = parsed.data;
      const [created] = await tx.insert(projects).values({ ...details, userId }).returning();
      if (!created) throw new Error("Project creation returned no record.");
      await pinInitialProjectSkills(tx, created.id, userId, skillVersionIds);
      return created;
    });
  } catch (error) {
    if (error instanceof SkillError) return Response.json({ error: error.message }, { status: error.status });
    throw error;
  }

  return Response.json({ project }, { status: 201 });
}
