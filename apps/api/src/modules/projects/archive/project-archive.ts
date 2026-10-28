/**
 * Reversible project archive lifecycle.
 * Creator-only reviewed actions preserve source/history/resources while denying new work.
 * Queue/account/project locks and cleanup/uncertain-effect blockers fence changes; restore never restarts jobs or deployments.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  projects,
  projectAccessActions,
  conversationTurns,
  conversations,
  buildJobs,
  builds,
  previews,
  previewAccess,
  deployments,
} from "@wrenly/db";
import {
  requireProjectCapability,
  ProjectAccessError,
} from "../access/project-access";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { lockDatabaseQueues } from "../../databases/database-store";
import { hasDatabaseWork } from "../../databases/database-activity";
import { logger } from "../../../lib/logger";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const ArchiveChange = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
    archived: z.boolean(),
  })
  .strict();
export class ProjectArchiveError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ProjectArchiveError";
  }
}
export interface ProjectArchiveState {
  archivedAt: string | null;
  revision: string;
  canManage: boolean;
  blockers: string[];
  savedRevision?: string;
  replayed?: boolean;
}
async function blockers(tx: Transaction, id: string): Promise<string[]> {
  const result: string[] = [];
  const [turn] = await tx
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationTurns.conversationId),
    )
    .where(
      and(
        eq(conversations.projectId, id),
        or(
          inArray(conversationTurns.status, [
            "queued",
            "running",
            "waiting_build",
          ]),
          and(
            eq(conversationTurns.status, "interrupted"),
            isNull(conversationTurns.completedAt),
          ),
        ),
      ),
    )
    .limit(1);
  if (turn)
    result.push("Finish or recover the active conversation before archiving.");
  const [job] = await tx
    .select({ id: buildJobs.buildId })
    .from(buildJobs)
    .where(
      and(
        eq(buildJobs.projectId, id),
        or(
          inArray(buildJobs.status, ["queued", "running"]),
          and(
            eq(buildJobs.status, "interrupted"),
            isNull(buildJobs.completedAt),
          ),
        ),
      ),
    )
    .limit(1);
  const [legacy] = await tx
    .select({ id: builds.id })
    .from(builds)
    .where(
      and(
        eq(builds.projectId, id),
        inArray(builds.status, ["pending", "generating", "building"]),
      ),
    )
    .limit(1);
  if (job || legacy)
    result.push("Finish or recover the active build before archiving.");
  const [preview] = await tx
    .select({ id: previews.id })
    .from(previews)
    .where(
      and(
        eq(previews.projectId, id),
        or(
          inArray(previews.status, [
            "queued",
            "preparing",
            "starting",
            "ready",
          ]),
          isNull(previews.cleanupCompletedAt),
        ),
      ),
    )
    .limit(1);
  if (preview)
    result.push(
      "Stop the local preview and wait for confirmed cleanup before archiving.",
    );
  const [publishing] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.projectId, id),
        or(
          inArray(deployments.status, [
            "queued",
            "preparing",
            "deploying",
            "verifying",
            "interrupted",
          ]),
          isNotNull(deployments.mutationIntent),
        ),
      ),
    )
    .limit(1);
  if (publishing)
    result.push(
      "Finish or reconcile publishing before archiving. A settled published app can remain online.",
    );
  if (await hasDatabaseWork(tx, id))
    result.push("Finish or reconcile database work before archiving.");
  return result;
}
async function state(
  tx: Transaction,
  id: string,
  actor: string,
): Promise<ProjectArchiveState> {
  const access = await requireProjectCapability(tx, id, actor, "read");
  const [project] = await tx
    .select({
      revision: projects.accessRevision,
      archivedAt: projects.archivedAt,
    })
    .from(projects)
    .where(eq(projects.id, id));
  if (!project) throw new ProjectArchiveError(404, "Project not found.");
  return {
    revision: project.revision,
    archivedAt: project.archivedAt?.toISOString() ?? null,
    canManage: access.role === "owner",
    blockers:
      access.role === "owner" && !project.archivedAt
        ? await blockers(tx, id)
        : [],
  };
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof ProjectArchiveError ||
      error instanceof ProjectAccessError ||
      error instanceof AccessDeniedError
    )
      throw error;
    logger.error("Project archive operation could not be confirmed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new ProjectArchiveError(
      503,
      "Archive state could not be confirmed. Reload or retry the same change.",
    );
  }
}
/** Preflight is advisory; mutation rechecks blockers under every admission queue. */
export async function readProjectArchive(
  database: typeof db,
  id: string,
  actor: string,
): Promise<ProjectArchiveState> {
  return operation(() => database.transaction((tx) => state(tx, id, actor)));
}
/** Exact replay acknowledges state; restore never reruns jobs or restarts deployments. */
export async function changeProjectArchive(
  database: typeof db,
  id: string,
  actor: string,
  body: unknown,
): Promise<ProjectArchiveState> {
  const parsed = ArchiveChange.safeParse(body);
  if (!parsed.success)
    throw new ProjectArchiveError(
      400,
      "Review the archive choice and current project revision.",
    );
  const input = parsed.data,
    identity = createHash("sha256")
      .update(
        JSON.stringify(["archive", id, input.expectedRevision, input.archived]),
      )
      .digest("hex");
  return operation(() =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const current = await state(tx, id, actor);
      if (!current.canManage)
        throw new ProjectArchiveError(
          403,
          "Only the project owner can archive or restore it.",
        );
      const [prior] = await tx
        .select()
        .from(projectAccessActions)
        .where(
          and(
            eq(projectAccessActions.projectId, id),
            eq(projectAccessActions.actorId, actor),
            eq(projectAccessActions.requestId, input.requestId),
          ),
        );
      if (prior) {
        if (prior.requestIdentity !== identity)
          throw new ProjectArchiveError(
            409,
            "This request belongs to another project change.",
          );
        return { ...current, savedRevision: prior.revision, replayed: true };
      }
      if (current.revision !== input.expectedRevision)
        throw new ProjectArchiveError(
          409,
          "Project settings changed. Reload and review before archiving or restoring.",
        );
      const reasons = current.archivedAt
        ? await blockers(tx, id)
        : current.blockers;
      if (reasons.length) throw new ProjectArchiveError(409, reasons.join(" "));
      const revision = crypto.randomUUID(),
        archivedAt = input.archived ? new Date() : null;
      await tx
        .update(projects)
        .set({ archivedAt, accessRevision: revision, updatedAt: new Date() })
        .where(eq(projects.id, id));
      await tx
        .delete(previewAccess)
        .where(
          inArray(
            previewAccess.previewId,
            tx
              .select({ id: previews.id })
              .from(previews)
              .where(eq(previews.projectId, id)),
          ),
        );
      await tx.insert(projectAccessActions).values({
        projectId: id,
        actorId: actor,
        requestId: input.requestId,
        requestIdentity: identity,
        previousRevision: current.revision,
        revision,
      });
      return {
        archivedAt: archivedAt?.toISOString() ?? null,
        revision,
        canManage: true,
        blockers: [],
        savedRevision: revision,
        replayed: false,
      };
    }),
  );
}
