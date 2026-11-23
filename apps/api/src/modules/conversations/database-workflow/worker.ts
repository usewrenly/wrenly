/** Follows durable receipts; fixed request identities prevent restart from duplicating external effects. */
import { and, eq, inArray } from "drizzle-orm";
import {
  conversationDatabaseWorkflows as workflows,
  conversationTurns,
  conversationActions,
  appDatabases,
  appDatabaseOperations,
  appDatabaseBackups,
  buildJobs,
  projects,
  type db,
} from "@wrenly/db";
import { accessContext } from "../../auth/access/access-context";
import { readActivePrincipal } from "../../auth/access/access-policy";
import {
  readProjectCapabilities,
  requireProjectCapability,
} from "../../projects/access/project-access";
import {
  admitDatabaseAction,
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
} from "../../databases/database-store";
import { readDatabaseMigrationReview } from "../../databases/database-review-store";
import { readDatabaseRevisionBinding } from "../../databases/bindings/revision-binding";
import {
  admitBuild,
  type AdmissionDependencies,
} from "../../builds/admission/build-admission";
import { RUNNING_WORKFLOW_STATES, type Workflow } from "./store";
import { logger } from "../../../lib/logger";
import { AppDatabaseError } from "../../databases/database-contract";

/** These are local admission/read failures, not a failed SQL execution receipt. */
function admissionUnavailable(error: unknown): boolean {
  if (error instanceof AppDatabaseError && [429, 503].includes(error.status))
    return true;
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause instanceof Error; depth++) {
    if (
      "code" in cause &&
      ["55P03", "40001", "40P01"].includes(String(cause.code))
    )
      return true;
    cause = cause.cause;
  }
  return false;
}

export interface WorkflowServices {
  directory: string;
  build: Pick<
    AdmissionDependencies,
    | "resolveProvider"
    | "defaultModel"
    | "resolveSelection"
    | "validateAttachments"
  >;
}
type Patch = Partial<typeof workflows.$inferInsert>;
const TERMINAL_BUILD = new Set([
  "success",
  "failed",
  "interrupted",
  "cancelled",
]);

/** Every state change repeats ordered authority checks; another poll cannot overwrite a later state. */
async function advance(
  database: typeof db,
  row: Workflow,
  patch: Patch,
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx, { wait: true });
    await requireProjectCapability(
      tx,
      row.projectId,
      row.principal!.userId,
      "manage",
    );
    const [project] = await tx
      .select({ revision: projects.accessRevision })
      .from(projects)
      .where(eq(projects.id, row.projectId));
    if (project?.revision !== row.accessRevision)
      throw new Error("Project authority changed");
    await tx
      .update(workflows)
      .set({ ...patch, revision: crypto.randomUUID(), updatedAt: new Date() })
      .where(
        and(eq(workflows.id, row.id), eq(workflows.revision, row.revision)),
      );
  });
}

async function startSavedBuild(
  database: typeof db,
  row: Workflow,
  services: WorkflowServices,
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx, { wait: true });
    await requireProjectCapability(
      tx,
      row.projectId,
      row.principal!.userId,
      "manage",
    );
    const [current] = await tx
      .select()
      .from(workflows)
      .where(eq(workflows.id, row.id))
      .for("update");
    if (
      !current ||
      current.revision !== row.revision ||
      current.state !== "building"
    )
      return;
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, row.projectId));
    const [turn] = await tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, row.turnId));
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(eq(appDatabases.id, row.resourceId!));
    if (
      !project ||
      project.accessRevision !== row.accessRevision ||
      !turn ||
      turn.actorId !== row.principal!.userId ||
      turn.status !== "completed" ||
      !resource ||
      resource.status !== "ready" ||
      resource.revision !== row.resourceRevision
    )
      throw new Error("Saved setup or conversation changed");
    await requireDatabaseProjectIdle(tx, row.projectId);
    const result = await admitBuild(
      {
        projectId: row.projectId,
        prompt: row.prompt,
        model: turn.model,
        provider: turn.provider,
        stack: project.stack,
        ...(turn.baseBuildId ? { previousBuildId: turn.baseBuildId } : {}),
      },
      turn.actorId,
      row.buildRequestId,
      {
        ...services.build,
        db: database,
        transaction: tx,
        frozenSkills: turn.skillsV1,
        ...(turn.attachmentsV1?.files.length
          ? { frozenAttachments: turn.attachmentsV1 }
          : {}),
        databaseSelection: {
          version: 1,
          environment: "development",
          resourceId: resource.id,
          resourceRevision: resource.revision,
        },
      },
    );
    await tx
      .insert(conversationActions)
      .values({ turnId: turn.id, buildId: result.buildId });
    await tx
      .update(conversationTurns)
      .set({
        status: "waiting_build",
        completedAt: null,
        databaseV1: {
          version: 1,
          environment: "development",
          resourceId: resource.id,
          resourceRevision: resource.revision,
        },
      })
      .where(eq(conversationTurns.id, turn.id));
    await tx
      .update(workflows)
      .set({
        state: "waiting_build",
        buildId: result.buildId,
        revision: crypto.randomUUID(),
        updatedAt: new Date(),
      })
      .where(eq(workflows.id, row.id));
  });
}

async function followOperation(
  database: typeof db,
  row: Workflow,
  services: WorkflowServices,
): Promise<void> {
  if (!row.operation) throw new Error("Saved database action unavailable");
  // Admission itself is actor-scoped and idempotent. Never construct a new key on replay.
  const receipt = await admitDatabaseAction(
    database,
    row.projectId,
    row.principal!.userId,
    row.operation,
    services.directory,
    {
      beforeAdmission: async (tx) => {
        const [current] = await tx
          .select()
          .from(workflows)
          .where(eq(workflows.id, row.id))
          .for("update");
        const [project] = await tx
          .select({ revision: projects.accessRevision })
          .from(projects)
          .where(eq(projects.id, row.projectId));
        if (
          !current ||
          current.revision !== row.revision ||
          current.state !== row.state ||
          project?.revision !== row.accessRevision ||
          !current.expiresAt ||
          current.expiresAt.getTime() <= Date.now()
        )
          throw new Error("Workflow approval changed before admission");
      },
    },
  );
  const [operation] = await database
    .select()
    .from(appDatabaseOperations)
    .where(eq(appDatabaseOperations.id, receipt.operationId));
  if (
    !operation ||
    operation.requestId !== row.operation.requestId ||
    operation.projectId !== row.projectId
  )
    throw new Error("Saved database receipt unavailable");
  if (operation.status === "queued" || operation.status === "running") return;
  if (operation.status !== "success")
    throw new Error("Database action needs review");
  const [resource] = await database
    .select()
    .from(appDatabases)
    .where(
      and(
        eq(appDatabases.id, receipt.resourceId),
        eq(appDatabases.projectId, row.projectId),
      ),
    );
  if (!resource || resource.status !== "ready")
    throw new Error("Ready resource could not be confirmed");
  if (row.state === "setup") {
    await advance(database, row, {
      state: "building",
      resourceId: resource.id,
      resourceRevision: resource.revision,
      operationId: operation.id,
      operation: null,
    });
    return;
  }
  if (row.state === "migrating") {
    await readDatabaseRevisionBinding(
      database,
      row.projectId,
      row.principal!.userId,
      {
        environment: "development",
        resourceId: resource.id,
        resourceRevision: resource.revision,
        buildId: row.buildId,
      },
    );
    await advance(database, row, {
      state: "complete",
      resourceRevision: resource.revision,
      operationId: operation.id,
      operation: null,
    });
    return;
  }
  if (row.state !== "backup" || !row.review || !row.buildId)
    throw new Error("Unexpected workflow phase");
  const [turn] = await database
    .select()
    .from(conversationTurns)
    .where(eq(conversationTurns.id, row.turnId));
  if (turn?.status === "waiting_build") return;
  const review = await readDatabaseMigrationReview(
    database,
    row.projectId,
    row.principal!.userId,
    resource.id,
    row.buildId,
  );
  if (
    review.migrationDigest !== row.review.migrationDigest ||
    JSON.stringify(review.files) !== JSON.stringify(row.review.files)
  )
    throw new Error("Reviewed migrations changed");
  const [backup] = await database
    .select()
    .from(appDatabaseBackups)
    .where(
      and(
        eq(appDatabaseBackups.operationId, operation.id),
        eq(appDatabaseBackups.databaseId, resource.id),
      ),
    );
  if (!backup?.verifiedAt || !backup.schemaDigest)
    throw new Error("Verified backup unavailable");
  await advance(database, row, {
    state: "migrating",
    resourceRevision: resource.revision,
    operationId: operation.id,
    operation: {
      requestId: crypto.randomUUID(),
      expectedRevision: resource.revision,
      environment: "development",
      kind: "migrate",
      buildId: row.buildId,
      backupId: backup.id,
      confirmChanges: true,
      migrationDigest: review.migrationDigest,
    },
  });
}

/** Polls a bounded batch without a browser connection. Unknown effects require owner review, never SQL replay. */
export async function reconcileDatabaseWorkflows(
  database: typeof db,
  services: WorkflowServices,
): Promise<void> {
  const rows = await database
    .select()
    .from(workflows)
    .where(inArray(workflows.state, [...RUNNING_WORKFLOW_STATES]))
    .limit(16);
  for (const row of rows) {
    try {
      const principal = row.principal;
      if (!principal || !row.expiresAt || row.expiresAt.getTime() <= Date.now())
        throw new Error("Approval expired");
      const active = await readActivePrincipal(
        database,
        principal.userId,
        principal.sessionId,
      );
      if (!active || active.revision !== principal.revision)
        throw new Error("Approval session unavailable");
      await accessContext.run({ principal }, async () => {
        if (
          !(
            await readProjectCapabilities(
              database,
              row.projectId,
              principal.userId,
            )
          )?.manage
        )
          throw new Error("Owner access changed");
        const [project] = await database
          .select({ revision: projects.accessRevision })
          .from(projects)
          .where(eq(projects.id, row.projectId));
        if (project?.revision !== row.accessRevision)
          throw new Error("Project authority changed");
        if (row.state === "building")
          return startSavedBuild(database, row, services);
        if (row.state !== "waiting_build")
          return followOperation(database, row, services);
        const [build] = await database
          .select({ status: buildJobs.status })
          .from(buildJobs)
          .where(eq(buildJobs.buildId, row.buildId!));
        if (!build || !TERMINAL_BUILD.has(build.status)) return;
        if (build.status !== "success")
          throw new Error("Application build did not succeed");
        const [turn] = await database
          .select({ status: conversationTurns.status })
          .from(conversationTurns)
          .where(eq(conversationTurns.id, row.turnId));
        if (turn?.status === "waiting_build") return;
        const [resource] = await database
          .select()
          .from(appDatabases)
          .where(eq(appDatabases.id, row.resourceId!));
        if (!resource || resource.status !== "ready")
          throw new Error("Database needs review");
        try {
          await readDatabaseRevisionBinding(
            database,
            row.projectId,
            principal.userId,
            {
              environment: "development",
              resourceId: resource.id,
              resourceRevision: resource.revision,
              buildId: row.buildId,
            },
          );
          await advance(database, row, {
            state: "complete",
            resourceRevision: resource.revision,
          });
        } catch {
          const review = await readDatabaseMigrationReview(
            database,
            row.projectId,
            principal.userId,
            resource.id,
            row.buildId!,
          );
          await advance(database, row, {
            state: "review",
            review,
            resourceRevision: resource.revision,
            operation: null,
          });
        }
      });
    } catch (error) {
      if (admissionUnavailable(error)) {
        logger.info("Conversation database admission deferred", {
          workflowId: row.id,
        });
        continue;
      }
      logger.error("Conversation database workflow needs review", {
        workflowId: row.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      await database
        .update(workflows)
        .set({
          state: "blocked",
          error:
            "This step could not be confirmed. Review its saved build/database activity before sending a new request; uncertain operations are never repeated.",
          revision: crypto.randomUUID(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(workflows.id, row.id), eq(workflows.revision, row.revision)),
        );
    }
  }
}
