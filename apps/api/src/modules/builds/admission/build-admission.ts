/**
 * Accepting and remembering a build request.
 * Checks the current actor/project, resolves the chosen model/source/skills and commits one queued operation before any model or Docker call.
 * A repeated request identity returns the same saved build instead of starting another.
 */
import { parseSkillGuidance, type SkillGuidance } from "@wrenly/inference";
import { freezeProjectSkills } from "../../skills/project-skills";
import { hasDatabaseWork } from "../../databases/database-activity";
import { freezeBuildDatabaseSelection } from "../../databases/bindings/build-selection";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { AppDatabaseError } from "../../databases/database-contract";
import {
  requireProjectCapability,
  ProjectAccessError,
} from "../../projects/access/project-access";
import {
  resolveProjectModelSelection,
  ProjectModelError,
} from "../../projects/sharing/project-model";
import { assertActiveAccount } from "../../auth/access/access-policy";
import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  builds,
  projects,
  buildJobs,
  buildEvents,
  buildQueue,
  type BuildJobInput,
} from "../../../../../../packages/db/src/schema";
import { GenerateRequestSchema } from "./build-contract";
import { logger } from "../../../lib/logger";

const IdempotencyKeySchema = z.string().uuid();
const QUEUE_LOCK_ID = 1;
const MAX_PENDING_BUILDS = 20;
const MAX_RETRY_ERROR_CHARS = 6000;
const FilesSchema = z.array(
  z.object({ path: z.string(), content: z.string() }),
);

type RequestInput = z.infer<typeof GenerateRequestSchema>;
type SavedBuild = typeof builds.$inferSelect;
export type BuildAdmissionTransaction = Parameters<
  Parameters<typeof db.transaction>[0]
>[0];

export class BuildAdmissionError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "BuildAdmissionError";
  }
}

export interface AdmissionDependencies {
  db: typeof db;
  resolveProvider: (id: string | undefined) => { id: string };
  resolveSelection?: (
    provider: string | undefined,
    model: string | undefined,
    database: BuildAdmissionTransaction,
  ) => Promise<{ provider: string; model: string }>;
  defaultModel: string;
  /** When linking a conversation action, admission must share its outer transaction. */
  frozenSkills?: SkillGuidance;
  /** A server-frozen choice used by atomic conversation handoff and controlled acceptance. */
  databaseSelection?: BuildDatabaseSelection;
  /** Browser selections remain rejected until the host composition enables the complete database workflow. */
  allowDatabaseSelection?: boolean;
  transaction?: BuildAdmissionTransaction;
}

/** Compares normalized caller inputs, independently of changing server defaults. */
export function buildRequestIdentity(input: RequestInput): string {
  return JSON.stringify([
    input.projectId,
    input.prompt ?? null,
    input.stack ?? null,
    input.model ?? null,
    input.provider ?? null,
    input.previousBuildId ?? null,
    input.retryBuildId ?? null,
    input.deploy,
    ...(input.database !== undefined ? [input.database] : []),
  ]);
}

/** No browser choice is accepted during partial activation, and server-frozen choices cannot be overridden. */
export function resolveRequestedBuildDatabase(input: RequestInput,
  dependencies: Pick<AdmissionDependencies, "allowDatabaseSelection" | "databaseSelection">): BuildDatabaseSelection | undefined {
  if (input.database !== undefined) {
    if (!dependencies.allowDatabaseSelection)
      throw new BuildAdmissionError(409, "Database-backed builds are not enabled on this instance yet.");
    if (dependencies.databaseSelection !== undefined)
      throw new BuildAdmissionError(400, "A saved database selection cannot be replaced by this request.");
  }
  return input.database ?? dependencies.databaseSelection;
}

/** Freezes source and retry diagnostics so queued execution never rereads a changed parent. */
export function resolveBuildJobInput(
  input: RequestInput,
  projectStack: BuildJobInput["stack"],
  parent: SavedBuild | undefined,
  dependencies: Pick<AdmissionDependencies, "resolveProvider" | "defaultModel">,
): BuildJobInput {
  if (input.deploy)
    throw new BuildAdmissionError(
      400,
      "Deployment is a separate action. Submit this build without deploy.",
    );
  const sourceId = input.retryBuildId ?? input.previousBuildId;
  if (
    sourceId &&
    (!parent || parent.id !== sourceId || parent.projectId !== input.projectId)
  )
    throw new BuildAdmissionError(404, "Previous build not found");
  if (parent && parent.status !== "success" && parent.status !== "failed")
    throw new BuildAdmissionError(
      409,
      "The previous build is still in progress.",
    );
  if (input.retryBuildId && parent?.status !== "failed")
    throw new BuildAdmissionError(409, "Only a failed build can be retried.");
  if (
    input.retryBuildId &&
    (!parent?.model || !parent.provider || !parent.stack)
  )
    throw new BuildAdmissionError(
      400,
      "This older build has no saved model settings. Submit a new build with your chosen model.",
    );
  const stack =
    (input.retryBuildId ? parent?.stack : input.stack) ?? projectStack;
  if (stack !== projectStack || (parent?.stack && parent.stack !== stack))
    throw new BuildAdmissionError(
      400,
      "The requested stack does not match this project.",
    );
  let provider: string;
  try {
    provider = dependencies.resolveProvider(
      input.retryBuildId ? (parent?.provider ?? undefined) : input.provider,
    ).id;
  } catch {
    throw new BuildAdmissionError(
      400,
      "The selected model provider is unavailable.",
    );
  }
  const files = FilesSchema.safeParse(parent?.files ?? []);
  if (!files.success)
    throw new BuildAdmissionError(
      409,
      "The previous build contains invalid source files.",
    );
  if (sourceId && files.data.length && !["nextjs", "laravel"].includes(stack))
    throw new BuildAdmissionError(
      409,
      "Revision-safe editing is not supported by this framework MCP server yet.",
    );
  return {
    prompt: input.retryBuildId ? (parent?.prompt ?? "") : (input.prompt ?? ""),
    stack,
    model:
      (input.retryBuildId ? parent?.model : input.model) ??
      dependencies.defaultModel,
    provider,
    previousFiles: files.data,
    previousErrors: input.retryBuildId
      ? [
          [parent?.errorMessage, parent?.buildLog]
            .filter(Boolean)
            .join("\n")
            .slice(-MAX_RETRY_ERROR_CHARS),
        ]
      : [],
  };
}

/** Atomically admits work; no inference, sandbox or deployment is performed here. */
export async function admitBuild(
  body: unknown,
  userId: string,
  idempotencyKey: string,
  dependencies: AdmissionDependencies,
): Promise<{ buildId: string; replayed: boolean }> {
  const parsed = GenerateRequestSchema.safeParse(body);
  if (
    !parsed.success ||
    !IdempotencyKeySchema.safeParse(idempotencyKey).success
  )
    throw new BuildAdmissionError(
      400,
      "Provide valid build settings and a UUID idempotency key.",
    );
  const input = parsed.data;
  if (input.deploy)
    throw new BuildAdmissionError(
      400,
      "Deployment is a separate action. Submit this build without deploy.",
    );
  const requestIdentity = dependencies.databaseSelection === undefined ? buildRequestIdentity(input)
    : JSON.stringify([buildRequestIdentity(input), BuildDatabaseSelection.parse(dependencies.databaseSelection)]);
  try {
    const executeAdmission = async (
      transaction: BuildAdmissionTransaction,
    ): Promise<{ buildId: string; replayed: boolean }> => {
      // Serialize the check and insertion: counting alone is unsafe under concurrency.
      await transaction
        .insert(buildQueue)
        .values({ id: QUEUE_LOCK_ID })
        .onConflictDoNothing();
      await transaction
        .select()
        .from(buildQueue)
        .where(eq(buildQueue.id, QUEUE_LOCK_ID))
        .for("update");
      await assertActiveAccount(transaction, userId);
      const [existing] = await transaction
        .select()
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.userId, userId),
            eq(buildJobs.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        try {
          await requireProjectCapability(
            transaction,
            existing.projectId,
            userId,
            "contribute",
          );
        } catch (error) {
          if (error instanceof ProjectAccessError)
            throw new BuildAdmissionError(error.status, error.message);
          throw error;
        }
        if (existing.requestIdentity !== requestIdentity)
          throw new BuildAdmissionError(
            409,
            "This idempotency key was already used for different build settings.",
          );
        return { buildId: existing.buildId, replayed: true };
      }
      const databaseSelection = resolveRequestedBuildDatabase(input, dependencies);
      const [capacity] = await transaction
        .select({ total: count() })
        .from(buildJobs)
        .where(inArray(buildJobs.status, ["queued", "running"]));
      if ((capacity?.total ?? 0) >= MAX_PENDING_BUILDS)
        throw new BuildAdmissionError(
          429,
          "The build queue is full. Try again after a build finishes.",
        );
      let [project] = await transaction
        .select()
        .from(projects)
        .where(eq(projects.id, input.projectId))
        .for("update");
      if (project) {
        try {
          await requireProjectCapability(
            transaction,
            project.id,
            userId,
            "contribute",
          );
        } catch (error) {
          if (error instanceof ProjectAccessError)
            throw new BuildAdmissionError(error.status, error.message);
          throw error;
        }
      }
      if (!project) {
        if (input.retryBuildId || input.previousBuildId)
          throw new BuildAdmissionError(404, "Project not found");
        await transaction
          .insert(projects)
          .values({
            id: input.projectId,
            userId,
            stack: input.stack ?? "nextjs",
            name: (input.prompt ?? "").slice(0, 50).trim(),
          })
          .onConflictDoNothing();
        [project] = await transaction
          .select()
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .for("update");
        if (!project || project.userId !== userId)
          throw new BuildAdmissionError(404, "Project not found");
      }
      if (await hasDatabaseWork(transaction, project.id))
        throw new BuildAdmissionError(
          409,
          "Finish or reconcile the database operation before building.",
        );
      const [active] = await transaction
        .select({ id: buildJobs.buildId })
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.projectId, project.id),
            inArray(buildJobs.status, ["queued", "running"]),
          ),
        )
        .limit(1);
      if (active)
        throw new BuildAdmissionError(
          409,
          "This project already has an active build.",
        );
      // During cutover, older request-scoped executions must also block admission.
      const [legacyActive] = await transaction
        .select({ id: builds.id })
        .from(builds)
        .where(
          and(
            eq(builds.projectId, project.id),
            inArray(builds.status, ["pending", "generating", "building"]),
          ),
        )
        .limit(1);
      if (legacyActive)
        throw new BuildAdmissionError(
          409,
          "This project already has an active build.",
        );
      const sourceId = input.retryBuildId ?? input.previousBuildId;
      let [parent] = sourceId
        ? await transaction
            .select()
            .from(builds)
            .where(eq(builds.id, sourceId))
            .limit(1)
        : [];
      if (sourceId && (!parent || parent.projectId !== project.id))
        throw new BuildAdmissionError(404, "Previous build not found");
      if (
        input.retryBuildId &&
        parent?.files == null &&
        parent?.parentBuildId
      ) {
        const [originalJob] = await transaction
          .select({ input: buildJobs.input })
          .from(buildJobs)
          .where(eq(buildJobs.buildId, parent.id))
          .limit(1);
        const savedSource = FilesSchema.safeParse(
          originalJob?.input?.previousFiles,
        );
        if (!savedSource.success || !savedSource.data.length)
          throw new BuildAdmissionError(
            409,
            "This failed build has no recoverable source context. Select its base revision and submit a new request.",
          );
        parent = { ...parent, files: savedSource.data };
      }
      let settings: { provider: string; model: string } | undefined;
      if (dependencies.resolveSelection || project.accessMode !== "private") {
        try {
          settings = await resolveProjectModelSelection(
            transaction,
            project,
            userId,
            {
              provider: input.retryBuildId
                ? (parent?.provider ?? undefined)
                : input.provider,
              model: input.retryBuildId
                ? (parent?.model ?? undefined)
                : input.model,
              retry: Boolean(input.retryBuildId),
            },
            async (provider, model) =>
              dependencies.resolveSelection
                ? dependencies.resolveSelection(provider, model, transaction)
                : {
                    provider: dependencies.resolveProvider(provider).id,
                    model: model ?? dependencies.defaultModel,
                  },
          );
        } catch (error) {
          throw new BuildAdmissionError(
            400,
            error instanceof ProjectModelError && error.status === 400
              ? error.message
              : "The selected provider/model is unavailable. Choose a model or check its configured connection.",
          );
        }
      }
      const resolved = resolveBuildJobInput(
        input,
        project.stack,
        parent,
        settings
          ? {
              ...dependencies,
              resolveProvider: () => ({ id: settings!.provider }),
              defaultModel: settings.model,
            }
          : dependencies,
      );
      if (input.retryBuildId) {
        const [original] = await transaction
          .select({ input: buildJobs.input })
          .from(buildJobs)
          .where(eq(buildJobs.buildId, input.retryBuildId));
        resolved.skillsV1 = parseSkillGuidance(original?.input.skillsV1);
        if (dependencies.databaseSelection !== undefined)
          throw new BuildAdmissionError(400, "Retry uses the saved database choice. Submit a new request to change it.");
        try {
          resolved.databaseV1 = await freezeBuildDatabaseSelection(transaction, project.id, userId, resolved.stack, original?.input.databaseV1);
        } catch (error) {
          if (error instanceof AppDatabaseError) throw new BuildAdmissionError(409, error.message);
          throw error;
        }
      } else {
        resolved.skillsV1 =
          dependencies.frozenSkills !== undefined
            ? parseSkillGuidance(dependencies.frozenSkills)
            : {
                version: 1,
                skills: await freezeProjectSkills(transaction, project.id),
              };
        try {
          resolved.databaseV1 = await freezeBuildDatabaseSelection(transaction, project.id, userId, resolved.stack, databaseSelection);
        } catch (error) {
          if (error instanceof AppDatabaseError) throw new BuildAdmissionError(409, error.message);
          throw error;
        }
      }
      const buildId = crypto.randomUUID();
      await transaction.insert(builds).values({
        id: buildId,
        projectId: project.id,
        prompt: resolved.prompt,
        stack: resolved.stack,
        model: resolved.model,
        provider: resolved.provider,
        parentBuildId: sourceId ?? null,
        status: "pending",
      });
      await transaction.insert(buildJobs).values({
        buildId,
        projectId: project.id,
        userId,
        idempotencyKey,
        requestIdentity,
        input: resolved,
        nextEventSequence: 2,
      });
      await transaction.insert(buildEvents).values({
        buildId,
        sequence: 1,
        type: "status",
        data: {
          buildId,
          phase: "queued",
          attempt: 0,
          message: "Build queued.",
        },
      });
      return { buildId, replayed: false };
    };
    return dependencies.transaction
      ? await executeAdmission(dependencies.transaction)
      : await dependencies.db.transaction(executeAdmission);
  } catch (error) {
    // The transaction rolls back project, build, job and event together.
    if (!(error instanceof BuildAdmissionError))
      logger.error("Build admission persistence failed", {
        projectId: input.projectId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}
