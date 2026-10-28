import { inspectManagedDatabaseState } from "@wrenly/sandbox";
// Owner-confirmed recovery preserves unknown effects; inspection never repeats an operation.
import { createHash } from "node:crypto";
import { and, eq, inArray, ne } from "drizzle-orm";
import { DatabaseRecovery } from "@wrenly/db/app-database-action-contract";
export { DatabaseRecovery } from "@wrenly/db/app-database-action-contract";
import type { db } from "@wrenly/db";
import { appDatabases, appDatabaseOperations } from "@wrenly/db";
import {
  requireProjectCapability,
  readProjectCapabilities,
  ProjectAccessError,
} from "../projects/access/project-access";
import { AccessDeniedError } from "../auth/access/access-policy";
import { AppDatabaseError } from "./database-contract";
import { acquireDatabaseExecutorLock } from "./database-executor-lock";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
} from "./database-store";
/** Only effect-free interruptions can be resolved without inspecting external resources. */
async function recoverDatabaseAction(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
  kind: "recover-before-effect" | "recover-runtime-state",
): Promise<{ operationId: string; resourceId: string; replayed: boolean }> {
  const parsed = DatabaseRecovery.safeParse(body);
  if (!parsed.success)
    throw new AppDatabaseError(
      400,
      "Review the interrupted operation and current database revision.",
    );
  const input = parsed.data;
  const access = await readProjectCapabilities(database, projectId, actorId);
  if (!access?.manage)
    throw new ProjectAccessError(
      access ? 403 : 404,
      access
        ? "Only the project owner can recover its database."
        : "Project not found.",
    );
  const [original] = await database
    .select()
    .from(appDatabaseOperations)
    .where(
      and(
        eq(appDatabaseOperations.id, input.operationId),
        eq(appDatabaseOperations.projectId, projectId),
      ),
    );
  if (!original)
    throw new AppDatabaseError(404, "Database operation not found.");
  const identity = createHash("sha256")
    .update(JSON.stringify({ projectId, kind, ...input }))
    .digest("hex");
  const readReplay = async (
    tx: Parameters<Parameters<typeof database.transaction>[0]>[0],
  ): Promise<{
    operationId: string;
    resourceId: string;
    replayed: true;
  } | null> => {
    const [replay] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          eq(appDatabaseOperations.actorId, actorId),
          eq(appDatabaseOperations.requestId, input.requestId),
        ),
      );
    if (replay) {
      if (
        replay.requestIdentity !== identity ||
        replay.projectId !== projectId ||
        replay.kind !== kind
      )
        throw new AppDatabaseError(
          409,
          "This request belongs to a different database action.",
        );
      return {
        operationId: replay.id,
        resourceId: replay.databaseId,
        replayed: true as const,
      };
    }
    return null;
  };
  // A saved reply is readable even when a later executor owns the resource lock.
  const saved = await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await requireProjectCapability(tx, projectId, actorId, "manage");
    return readReplay(tx);
  });
  if (saved) return saved;
  const lock = await acquireDatabaseExecutorLock({
    id: input.operationId,
    resourceId: original.databaseId,
    projectId,
    token: crypto.randomUUID(),
  }).catch(() => {
    throw new AppDatabaseError(
      409,
      "The prior database executor has not released its resource. Wait before reviewing recovery again.",
    );
  });
  try {
    let inspectedState: "ready" | "stopped" | undefined;
    if (kind === "recover-runtime-state") {
      const [savedResource] = await database
        .select()
        .from(appDatabases)
        .where(eq(appDatabases.id, original.databaseId));
      if (
        !savedResource ||
        savedResource.revision !== input.expectedRevision ||
        savedResource.environment !== "development" ||
        savedResource.provider !== "local" ||
        !savedResource.runtimeIdentity ||
        !["start", "stop"].includes(original.kind)
      )
        throw new AppDatabaseError(
          409,
          "Only saved local stop/start operations can use runtime inspection recovery.",
        );
      inspectedState = await inspectManagedDatabaseState(
        { resourceId: savedResource.id, projectId, environment: "development" },
        savedResource.runtimeIdentity,
      );
      if (inspectedState !== (original.kind === "stop" ? "stopped" : "ready"))
        throw new AppDatabaseError(
          409,
          "The saved runtime has not reached the requested state. Its recovery fence has been preserved.",
        );
    }
    return await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "manage");
      const replay = await readReplay(tx);
      if (replay) return replay;
      await requireDatabaseProjectIdle(tx, projectId);
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.id, original.databaseId),
            eq(appDatabases.projectId, projectId),
          ),
        )
        .for("update");
      const [operation] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(eq(appDatabaseOperations.id, input.operationId))
        .for("update");
      const [other] = await tx
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.projectId, projectId),
            ne(appDatabaseOperations.id, input.operationId),
            inArray(appDatabaseOperations.status, [
              "queued",
              "running",
              "interrupted",
            ]),
          ),
        )
        .limit(1);
      if (
        !resource ||
        resource.revision !== input.expectedRevision ||
        resource.status !== "recovery_required" ||
        !operation ||
        operation.status !== "interrupted" ||
        operation.cleanupEffect !== null ||
        operation.completedCleanupEffects.length > 0 ||
        other
      )
        throw new AppDatabaseError(
          409,
          "The database changed or may have external effects. Its recovery fence has been preserved.",
        );
      if (kind === "recover-before-effect") {
        if (
          operation.effect ||
          operation.completedEffects.length ||
          !["create", "start", "stop", "backup", "migrate", "read"].includes(
            operation.kind,
          ) ||
          (operation.kind === "create"
            ? resource.runtimeIdentity !== null
            : resource.runtimeIdentity === null)
        )
          throw new AppDatabaseError(
            409,
            "This operation requires inspection recovery before it can be resolved.",
          );
      } else {
        const expectedState = operation.kind === "stop" ? "stopped" : "ready";
        const effects = [
          ...operation.completedEffects,
          ...(operation.effect ? [operation.effect] : []),
        ];
        if (
          !resource.runtimeIdentity ||
          !["start", "stop"].includes(operation.kind) ||
          inspectedState !== expectedState ||
          effects.some(
            (effect) =>
              effect.kind !== operation.kind ||
              effect.id !== resource.runtimeIdentity?.containerId,
          )
        )
          throw new AppDatabaseError(
            409,
            "The saved effect identity cannot be reconciled with runtime inspection.",
          );
      }
      lock.assertHeld();
      const id = crypto.randomUUID();
      await tx
        .update(appDatabaseOperations)
        .set({
          status: "failed",
          errorCode:
            kind === "recover-before-effect"
              ? "RECOVERED_BEFORE_EFFECT"
              : "RECOVERED_VERIFIED_STATE",
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(eq(appDatabaseOperations.id, operation.id));
      await tx.insert(appDatabaseOperations).values({
        id,
        databaseId: resource.id,
        projectId,
        actorId,
        requestId: input.requestId,
        requestIdentity: identity,
        kind,
        status: "success",
        expectedRevision: input.expectedRevision,
        completedAt: new Date(),
      });
      await tx
        .update(appDatabases)
        .set({
          status:
            inspectedState ??
            (operation.kind === "create"
              ? "failed"
              : operation.kind === "start"
                ? "stopped"
                : "ready"),
          revision: crypto.randomUUID(),
          errorCode:
            operation.kind === "create" ? "RECOVERED_BEFORE_EFFECT" : null,
          updatedAt: new Date(),
        })
        .where(eq(appDatabases.id, resource.id));
      return { operationId: id, resourceId: resource.id, replayed: false };
    });
  } catch (error) {
    if (
      error instanceof AppDatabaseError ||
      error instanceof ProjectAccessError ||
      error instanceof AccessDeniedError
    )
      throw error;
    throw new AppDatabaseError(
      503,
      "Recovery could not be confirmed. Check the same request before retrying.",
    );
  } finally {
    await lock.release();
  }
}

/** Resolves only interrupted actions that provably never reached an external effect. */
export async function recoverUnstartedDatabaseAction(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<{ operationId: string; resourceId: string; replayed: boolean }> {
  return recoverDatabaseAction(
    database,
    projectId,
    actorId,
    body,
    "recover-before-effect",
  );
}
/** Inspects saved local resources without rerunning an uncertain stop/start action. */
export async function recoverInspectedDatabaseAction(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
): Promise<{ operationId: string; resourceId: string; replayed: boolean }> {
  return recoverDatabaseAction(
    database,
    projectId,
    actorId,
    body,
    "recover-runtime-state",
  );
}
