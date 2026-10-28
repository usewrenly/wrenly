/**
 * Owner-managed project inference binding.
 * Resolves an explicit enabled provider/model and fences updates against current authority, access revision and active work.
 * Shared execution never silently falls back to another model or credential.
 */
import { hasDatabaseWork } from "../../databases/database-activity";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  projects,
  projectModels,
  projectAccessActions,
  conversationQueue,
  buildQueue,
  previewQueue,
  deploymentQueue,
  conversations,
  conversationTurns,
  builds,
  buildJobs,
} from "@wrenly/db";
import { requireProjectCapability } from "../access/project-access";
import {
  resolveInferenceSelection,
  type InferenceSelection,
} from "../../models/selection/saved-providers";
import { logger } from "../../../lib/logger";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = Pick<typeof db, "select">;
type Project = Pick<
  typeof projects.$inferSelect,
  "id" | "userId" | "accessMode"
>;
const QUEUE_ID = 1;
const MAX_ERROR_CAUSE_DEPTH = 6;
const ChangeSchema = z
  .object({
    requestId: z.string().uuid(),
    expectedRevision: z.string().uuid(),
    connectionId: z.string().uuid(),
    modelId: z.string().trim().min(1).max(512),
  })
  .strict();
export class ProjectModelError extends Error {
  constructor(
    public readonly status: 400 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "ProjectModelError";
  }
}
export interface ProjectModelChangeResult {
  savedRevision: string;
  currentRevision: string;
  replayed: boolean;
}

/** Resolves the approved shared connection without copying credentials or changing a frozen retry. */
export async function resolveProjectModelSelection(
  database: Database,
  project: Project,
  actorId: string,
  input: { provider?: string; model?: string; retry?: boolean },
  fallback: (
    provider: string | undefined,
    model: string | undefined,
  ) => Promise<InferenceSelection>,
): Promise<InferenceSelection> {
  try {
    if (
      project.accessMode === "private" ||
      (input.retry && project.userId === actorId)
    )
      return await fallback(input.provider, input.model);
    const [binding] = await database
      .select()
      .from(projectModels)
      .where(eq(projectModels.projectId, project.id));
    if (!binding)
      throw new ProjectModelError(
        400,
        "The project owner must configure a project model before new inference can start.",
      );
    let selected: InferenceSelection;
    try {
      selected = await resolveInferenceSelection(
        database,
        binding.connectionId,
        binding.modelId,
      );
    } catch {
      throw new ProjectModelError(
        400,
        "The project model connection is unavailable. Ask the project owner to review it; no fallback was used.",
      );
    }
    if (
      (input.model !== undefined && input.model !== selected.model) ||
      (input.provider !== undefined &&
        input.provider !== selected.provider &&
        input.provider !== binding.connectionId)
    )
      throw new ProjectModelError(
        400,
        "This project uses an owner-managed model. Use its current model or ask the owner to change it.",
      );
    return selected;
  } catch (error) {
    if (!(error instanceof ProjectModelError))
      logger.error("Project model resolution failed", {
        projectId: project.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error instanceof ProjectModelError
      ? error
      : new ProjectModelError(503, "The project model could not be resolved.");
  }
}

/** Owner mutation used by reviewed project settings; acknowledgement is reconciled by the audited request. */
export async function changeProjectModel(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<ProjectModelChangeResult> {
  const parsed = ChangeSchema.safeParse(body);
  if (!parsed.success || !z.string().uuid().safeParse(projectId).success)
    throw new ProjectModelError(
      400,
      "Choose a saved connection and model, with valid change and revision identifiers.",
    );
  const input = parsed.data;
  const identity = JSON.stringify([
    "project-model",
    input.expectedRevision,
    input.connectionId,
    input.modelId,
  ]);
  try {
    return await database.transaction(async (transaction) => {
      await lockQueues(transaction);
      await requireProjectCapability(transaction, projectId, actorId, "manage");
      const [project] = await transaction
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) throw new Error("Locked project missing");
      const [prior] = await transaction
        .select()
        .from(projectAccessActions)
        .where(
          and(
            eq(projectAccessActions.projectId, projectId),
            eq(projectAccessActions.actorId, actorId),
            eq(projectAccessActions.requestId, input.requestId),
          ),
        );
      if (prior) {
        if (prior.requestIdentity !== identity)
          throw new ProjectModelError(
            409,
            "This change identifier was already used for different settings.",
          );
        return {
          savedRevision: prior.revision,
          currentRevision: project.accessRevision,
          replayed: true,
        };
      }
      if (project.accessRevision !== input.expectedRevision)
        throw new ProjectModelError(
          409,
          "Project settings changed. Reload and review before saving.",
        );
      if (await hasDatabaseWork(transaction, projectId))
        throw new ProjectModelError(
          409,
          "Finish or reconcile database work before changing the project model.",
        );
      const [turn] = await transaction
        .select({ id: conversationTurns.id })
        .from(conversationTurns)
        .innerJoin(
          conversations,
          eq(conversations.id, conversationTurns.conversationId),
        )
        .where(
          and(
            eq(conversations.projectId, projectId),
            inArray(conversationTurns.status, [
              "queued",
              "running",
              "waiting_build",
            ]),
          ),
        )
        .limit(1);
      const [job] = await transaction
        .select({ id: buildJobs.buildId })
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.projectId, projectId),
            inArray(buildJobs.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      const [legacy] = await transaction
        .select({ id: builds.id })
        .from(builds)
        .where(
          and(
            eq(builds.projectId, projectId),
            inArray(builds.status, ["pending", "generating", "building"]),
          ),
        )
        .limit(1);
      if (turn || job || legacy)
        throw new ProjectModelError(
          409,
          "Wait for active project conversations and builds to finish before changing its model.",
        );
      try {
        await resolveInferenceSelection(
          transaction,
          input.connectionId,
          input.modelId,
        );
      } catch {
        throw new ProjectModelError(
          400,
          "The saved provider connection is disabled or unavailable. Review it before selecting a project model.",
        );
      }
      await transaction
        .insert(projectModels)
        .values({
          projectId,
          connectionId: input.connectionId,
          modelId: input.modelId,
        })
        .onConflictDoUpdate({
          target: projectModels.projectId,
          set: {
            connectionId: input.connectionId,
            modelId: input.modelId,
            updatedAt: new Date(),
          },
        });
      const revision = crypto.randomUUID();
      await transaction
        .update(projects)
        .set({ accessRevision: revision })
        .where(eq(projects.id, projectId));
      await transaction.insert(projectAccessActions).values({
        requestId: input.requestId,
        actorId,
        projectId,
        requestIdentity: identity,
        previousRevision: project.accessRevision,
        revision,
      });
      return {
        savedRevision: revision,
        currentRevision: revision,
        replayed: false,
      };
    });
  } catch (error) {
    if (error instanceof ProjectModelError) throw error;
    let cause: unknown = error;
    for (
      let depth = 0;
      depth < MAX_ERROR_CAUSE_DEPTH && cause && typeof cause === "object";
      depth++
    ) {
      if ("code" in cause && (cause.code === "55P03" || cause.code === "40P01"))
        throw new ProjectModelError(
          409,
          "Project work is busy. Wait and review the settings again.",
        );
      cause = "cause" in cause ? cause.cause : null;
    }
    // Preserve existing typed authorization errors for callers; never convert a denial to success.
    if (
      error instanceof Error &&
      ["ProjectAccessError", "AccessDeniedError"].includes(error.name)
    )
      throw error;
    logger.error("Project model change failed", {
      projectId,
      actorId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new ProjectModelError(
      503,
      "The project model save could not be confirmed. Check the saved change before retrying.",
    );
  }
}
async function lockQueues(transaction: Transaction): Promise<void> {
  try {
    for (const table of [
      conversationQueue,
      buildQueue,
      previewQueue,
      deploymentQueue,
    ]) {
      await transaction
        .insert(table)
        .values({ id: QUEUE_ID })
        .onConflictDoNothing();
      await transaction
        .select()
        .from(table)
        .where(eq(table.id, QUEUE_ID))
        .for("update", { noWait: true });
    }
  } catch (error) {
    throw new Error("Project queue lock failed.", { cause: error });
  }
}
