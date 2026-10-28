/**
 * Authorized project workspace snapshot.
 * Uses current project-read policy and capabilities before returning retained revisions and safe model metadata.
 * Retains failed artifacts for reload and resolves actual authors without provider credentials.
 */
import { getProjectAuthors } from "./project-authors";
import {
  readableProjectPredicate,
  readProjectCapabilities,
} from "../access/project-access";
//
// GET /api/projects/:id — one project with its full build history.
// Serves the workspace page: prompts, statuses, logs and error messages.
// Files are included so failed and successful artifacts survive reloads.

import { requireUserId } from "../../auth/access/session";
import { db as defaultDatabase } from "@wrenly/db";
import {
  projects,
  builds,
  buildJobs,
  projectModels,
  providerConnections,
} from "@wrenly/db";
import { and, eq, desc } from "drizzle-orm";

export async function getProject(
  request: Request,
  id: string,
  dependencies?: {
    developmentDatabases?: boolean;
    database: typeof defaultDatabase;
    session: (headers: Headers) => Promise<string | null>;
  },
): Promise<Response> {
  const db = dependencies?.database ?? defaultDatabase;
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

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), readableProjectPredicate(db, userId)))
    .limit(1);

  if (!project) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const capabilities = await readProjectCapabilities(db, id, userId);
  if (!capabilities)
    return Response.json({ error: "Not found" }, { status: 404 });
  const buildRows = await db
    .select({
      id: builds.id,
      actorId: buildJobs.userId,
      prompt: builds.prompt,
      model: builds.model,
      provider: builds.provider,
      stack: builds.stack,
      parentBuildId: builds.parentBuildId,
      status: builds.status,
      outcome: buildJobs.status,
      attemptCount: builds.attemptCount,
      buildLog: builds.buildLog,
      errorMessage: builds.errorMessage,
      deployedUrl: builds.deployedUrl,
      createdAt: builds.createdAt,
      completedAt: builds.completedAt,
      files: builds.files,
    })
    .from(builds)
    .leftJoin(buildJobs, eq(buildJobs.buildId, builds.id))
    .where(eq(builds.projectId, id))
    .orderBy(desc(builds.createdAt));

  const [projectModel] = await db
    .select({
      connectionId: projectModels.connectionId,
      modelId: projectModels.modelId,
      version: providerConnections.version,
      enabled: providerConnections.enabled,
    })
    .from(projectModels)
    .innerJoin(
      providerConnections,
      eq(providerConnections.id, projectModels.connectionId),
    )
    .where(eq(projectModels.projectId, id));
  const authors = await getProjectAuthors(
    db,
    buildRows.map((row) => row.actorId ?? project.userId),
  );
  return Response.json(
    {
      features: { developmentDatabases: dependencies?.developmentDatabases === true },
      projectModel: projectModel ?? null,
      project,
      builds: buildRows.map((row) => ({
        ...row,
        author: authors.get(row.actorId ?? project.userId) ?? null,
      })),
      capabilities,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
