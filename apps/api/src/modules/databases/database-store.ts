import {
  prepareDatabaseMigrationReview,
  readFrozenMigrationSource,
} from "./database-migration-review";
import { hasDatabaseWork } from "./database-activity";
export { hasDatabaseWork } from "./database-activity";
// Admission stores reviewed intent under ordered locks; it never touches Docker.
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import { createHash } from "node:crypto";
import { AccessDeniedError } from "../auth/access/access-policy";
import { join } from "node:path";
import type { db } from "@wrenly/db";
import { DATABASE_STATUS_LIMITS } from "@wrenly/db/app-database-resource-contract";
import {
  appDatabases,
  appDatabaseOperations,
  appDatabaseQueue,
  appDatabaseMigrations,
  appDatabaseBackups,
  projects,
  conversationQueue,
  buildQueue,
  previewQueue,
  deploymentQueue,
  conversations,
  conversationTurns,
  buildJobs,
  builds,
  previews,
  deployments,
} from "@wrenly/db";
import {
  requireProjectCapability,
  readProjectCapabilities,
  ProjectAccessError,
} from "../projects/access/project-access";
import {
  DatabaseAction,
  DatabaseCredentials,
  createDatabaseCredentials,
  AppDatabaseError,
} from "./database-contract";
import {
  loadDatabaseKey,
  encryptDatabaseSecret,
  decryptDatabaseSecret,
} from "./database-secrets";
const QUEUE_ID = 1;
const MAX_PENDING = 8;
const MAX_RETAINED_BACKUPS = 16;
const MAX_MANAGED_RESOURCES = 8;
export const DATABASE_LEASE_MS = 30_000;
export interface DatabaseClaim {
  id: string;
  resourceId: string;
  projectId: string;
  token: string;
}
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const LIVE = ["queued", "running", "interrupted"] as const;
export type DatabaseResourceDto = Pick<
  typeof appDatabases.$inferSelect,
  | "id"
  | "projectId"
  | "environment"
  | "provider"
  | "status"
  | "revision"
  | "schemaDigest"
  | "errorCode"
  | "createdAt"
  | "updatedAt"
>;
function resourceDto(
  row: DatabaseResourceDto,
): DatabaseResourceDto {
  const {
    id,
    projectId,
    environment,
    provider,
    status,
    revision,
    schemaDigest,
    errorCode,
    createdAt,
    updatedAt,
  } = row;
  return {
    id,
    projectId,
    environment,
    provider,
    status,
    revision,
    schemaDigest,
    errorCode,
    createdAt,
    updatedAt,
  };
}
/** Safe read projection; encrypted credentials and provider/container internals never reach browsers. */
export async function readDatabaseResources(
  database: typeof db,
  projectId: string,
  actorId: string,
): Promise<{
  capabilities: {
    manage: boolean;
    developmentRows: boolean;
    productionRows: boolean;
  };
  resources: DatabaseResourceDto[];
  operations: Array<
    Pick<
      typeof appDatabaseOperations.$inferSelect,
      | "id"
      | "databaseId"
      | "kind"
      | "status"
      | "errorCode"
      | "createdAt"
      | "completedAt"
    >
  >;
}> {
  try {
    const access = await readProjectCapabilities(database, projectId, actorId);
    if (!access) throw new ProjectAccessError(404, "Project not found.");
    const [authority] = await database.select({ revision: projects.accessRevision })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!authority) throw new ProjectAccessError(404, "Project not found.");
    const resources = await database
      .select({ id: appDatabases.id, projectId: appDatabases.projectId,
        environment: appDatabases.environment, provider: appDatabases.provider,
        status: appDatabases.status, revision: appDatabases.revision,
        schemaDigest: appDatabases.schemaDigest, errorCode: appDatabases.errorCode,
        createdAt: appDatabases.createdAt, updatedAt: appDatabases.updatedAt })
      .from(appDatabases)
      .where(eq(appDatabases.projectId, projectId));
    const operations = await database
      .select({
        id: appDatabaseOperations.id,
        databaseId: appDatabaseOperations.databaseId,
        kind: appDatabaseOperations.kind,
        status: appDatabaseOperations.status,
        errorCode: appDatabaseOperations.errorCode,
        createdAt: appDatabaseOperations.createdAt,
        completedAt: appDatabaseOperations.completedAt,
      })
      .from(appDatabaseOperations)
      .where(eq(appDatabaseOperations.projectId, projectId))
      .orderBy(desc(appDatabaseOperations.createdAt))
      .limit(DATABASE_STATUS_LIMITS.operations);
    const current = await readProjectCapabilities(database, projectId, actorId);
    const [currentAuthority] = await database.select({ revision: projects.accessRevision })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!current || current.role !== access.role || current.manage !== access.manage ||
        current.contribute !== access.contribute || current.publish !== access.publish ||
        currentAuthority?.revision !== authority.revision)
      throw new ProjectAccessError(
        403,
        "Project access changed. Reload before viewing database status.",
      );
    return {
      capabilities: {
        manage: access.manage,
        developmentRows: access.contribute,
        productionRows: access.manage,
      },
      resources: resources.map(resourceDto),
      operations,
    };
  } catch (error) {
    if (
      error instanceof ProjectAccessError ||
      error instanceof AppDatabaseError
    )
      throw error;
    throw new AppDatabaseError(503, "Database status could not be loaded.");
  }
}
/** HTTP admission fails fast; trusted runtime transactions may wait in this fixed order,
 * then recheck their leases before writing. A scheduler poll must not fail unrelated preparation.
 */
export async function lockDatabaseQueues(
  transaction: Transaction,
  options: { wait?: boolean } = {},
): Promise<void> {
  for (const table of [
    conversationQueue,
    buildQueue,
    previewQueue,
    deploymentQueue,
    appDatabaseQueue,
  ]) {
    await transaction
      .insert(table)
      .values({ id: QUEUE_ID })
      .onConflictDoNothing();
    await transaction
      .select()
      .from(table)
      .where(eq(table.id, QUEUE_ID))
      .for("update", options.wait ? {} : { noWait: true });
  }
}
export async function requireDatabaseProjectIdle(
  transaction: Transaction,
  projectId: string,
): Promise<void> {
  const work = await Promise.all([
    transaction
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
      .limit(1),
    transaction
      .select({ id: buildJobs.buildId })
      .from(buildJobs)
      .where(
        and(
          eq(buildJobs.projectId, projectId),
          inArray(buildJobs.status, ["queued", "running"]),
        ),
      )
      .limit(1),
    transaction
      .select({ id: builds.id })
      .from(builds)
      .where(
        and(
          eq(builds.projectId, projectId),
          inArray(builds.status, ["pending", "generating", "building"]),
        ),
      )
      .limit(1),
    transaction
      .select({ id: previews.id })
      .from(previews)
      .where(
        and(
          eq(previews.projectId, projectId),
          isNull(previews.cleanupCompletedAt),
        ),
      )
      .limit(1),
    transaction
      .select({ id: deployments.id })
      .from(deployments)
      .where(
        and(
          eq(deployments.projectId, projectId),
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
      .limit(1),
  ]);
  if (work.some((rows) => rows.length))
    throw new AppDatabaseError(
      409,
      "Stop the preview and finish active project work or recovery before changing its database.",
    );
}
/** Serializes owner resource admission, exact actor-scoped replay and current project revision. */
export async function admitDatabaseAction(
  database: typeof db,
  projectId: string,
  actorId: string,
  body: unknown,
  dataDirectory: string,
): Promise<{ operationId: string; resourceId: string; replayed: boolean }> {
  const parsed = DatabaseAction.safeParse(body);
  if (!parsed.success)
    throw new AppDatabaseError(
      400,
      "Review the database environment, action and revision before submitting.",
    );
  const input = parsed.data;
  const access = await readProjectCapabilities(database, projectId, actorId);
  if (!access?.manage)
    throw new ProjectAccessError(
      access ? 403 : 404,
      access
        ? "Only the project owner can manage its database."
        : "Project not found.",
    );
  const [encrypted] = await database
    .select({ id: appDatabases.id })
    .from(appDatabases)
    .limit(1);
  const key = await loadDatabaseKey(
    join(dataDirectory, "database-keys"),
    Boolean(encrypted),
  );
  const identity = createHash("sha256")
    .update(JSON.stringify([projectId, input]))
    .digest("hex");
  try {
    return await database.transaction(async (transaction) => {
      await lockDatabaseQueues(transaction);
      await requireProjectCapability(transaction, projectId, actorId, "manage");
      const [replay] = await transaction
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
          replay.projectId !== projectId ||
          replay.requestIdentity !== identity
        )
          throw new AppDatabaseError(
            409,
            "This request identity belongs to a different database action.",
          );
        return {
          operationId: replay.id,
          resourceId: replay.databaseId,
          replayed: true,
        };
      }
      if (await hasDatabaseWork(transaction, projectId))
        throw new AppDatabaseError(
          409,
          "Finish or reconcile the existing database operation first.",
        );
      const pending = await transaction
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(inArray(appDatabaseOperations.status, [...LIVE]))
        .limit(MAX_PENDING);
      if (pending.length >= MAX_PENDING)
        throw new AppDatabaseError(
          429,
          "Database operation capacity is full. Finish existing work before trying again.",
        );
      await requireDatabaseProjectIdle(transaction, projectId);
      let migrationReview:
        Awaited<ReturnType<typeof prepareDatabaseMigrationReview>> | undefined;
      let [resource] = await transaction
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.projectId, projectId),
            eq(appDatabases.environment, input.environment),
          ),
        )
        .for("update");
      if (input.kind === "create") {
        if (input.environment !== "development")
          throw new AppDatabaseError(
            409,
            "Configure and verify a private Production provider before creating its database.",
          );
        if (resource) {
          if (
            resource.revision !== input.expectedRevision ||
            resource.status !== "failed" ||
            ![
              "PREREQUISITE_UNAVAILABLE",
              "ACTOR_ACCESS_CHANGED",
              "RECOVERED_BEFORE_EFFECT",
            ].includes(resource.errorCode ?? "") ||
            resource.runtimeIdentity
          )
            throw new AppDatabaseError(
              409,
              "This environment already has a database. Reload its current state or reconcile its saved operation.",
            );
          await transaction
            .update(appDatabases)
            .set({
              status: "provisioning",
              errorCode: null,
              updatedAt: new Date(),
            })
            .where(eq(appDatabases.id, resource.id));
        } else {
          if (input.expectedRevision !== null)
            throw new AppDatabaseError(
              409,
              "There is no resource matching this revision.",
            );
          const reserved = await transaction
            .select({ id: appDatabases.id })
            .from(appDatabases)
            .where(eq(appDatabases.provider, "local"))
            .limit(MAX_MANAGED_RESOURCES);
          if (reserved.length >= MAX_MANAGED_RESOURCES)
            throw new AppDatabaseError(
              429,
              "Managed database capacity is full. Stopped and interrupted resources still reserve their data; contact the instance operator.",
            );
          const resourceId = crypto.randomUUID();
          [resource] = await transaction
            .insert(appDatabases)
            .values({
              id: resourceId,
              projectId,
              environment: input.environment,
              provider: "local",
              createdBy: actorId,
              secrets: encryptDatabaseSecret(
                JSON.stringify(createDatabaseCredentials(resourceId)),
                key,
                `${resourceId}:${input.environment}`,
              ),
            })
            .returning();
        }
      } else {
        if (!resource || resource.revision !== input.expectedRevision)
          throw new AppDatabaseError(
            409,
            "The database changed. Reload before reviewing this action again.",
          );
        if (input.kind === "start" && resource.status !== "stopped")
          throw new AppDatabaseError(
            409,
            "Only a stopped database can be started.",
          );
        if (input.kind === "stop" && resource.status !== "ready")
          throw new AppDatabaseError(
            409,
            "Only a ready database can be stopped.",
          );
        if (input.kind === "backup") {
          if (
            resource.status !== "ready" ||
            resource.provider !== "local" ||
            resource.environment !== "development"
          )
            throw new AppDatabaseError(
              409,
              "Backups require a ready local Development database.",
            );
          const retained = await transaction
            .select({ id: appDatabaseOperations.id })
            .from(appDatabaseOperations)
            .where(
              and(
                eq(appDatabaseOperations.databaseId, resource.id),
                eq(appDatabaseOperations.kind, "backup"),
              ),
            )
            .limit(MAX_RETAINED_BACKUPS);
          if (retained.length >= MAX_RETAINED_BACKUPS)
            throw new AppDatabaseError(
              429,
              "Backup retention capacity is full. Ask the instance operator to review retained archives before creating another backup.",
            );
        }
        if (input.kind === "migrate") {
          if (
            resource.status !== "ready" ||
            resource.provider !== "local" ||
            resource.environment !== "development" ||
            !input.buildId ||
            !input.backupId ||
            !input.migrationDigest ||
            !input.confirmChanges
          )
            throw new AppDatabaseError(
              409,
              "Review a ready local Development database before confirming migrations.",
            );
          migrationReview = await prepareDatabaseMigrationReview(transaction, {
            projectId,
            resourceId: resource.id,
            buildId: input.buildId,
            backupId: input.backupId,
            migrationDigest: input.migrationDigest,
          });
        }
        if (resource.status === "recovery_required")
          throw new AppDatabaseError(
            409,
            "Reconcile the interrupted database operation before admitting more work.",
          );
      }
      if (!resource)
        throw new Error(
          "Database resource admission did not return an identity.",
        );
      const id = crypto.randomUUID();
      await transaction.insert(appDatabaseOperations).values({
        id,
        projectId,
        databaseId: resource.id,
        actorId,
        requestId: input.requestId,
        requestIdentity: identity,
        kind: input.kind,
        expectedRevision: input.expectedRevision,
        buildId: input.buildId,
        migrationDigest: input.migrationDigest,
      });
      if (migrationReview && input.buildId && input.migrationDigest)
        await transaction.insert(appDatabaseMigrations).values({
          databaseId: resource.id,
          operationId: id,
          buildId: input.buildId,
          digest: input.migrationDigest,
          ...migrationReview,
        });
      return { operationId: id, resourceId: resource.id, replayed: false };
    });
  } catch (error) {
    if (
      error instanceof AppDatabaseError ||
      error instanceof ProjectAccessError
    )
      throw error;
    throw new AppDatabaseError(
      503,
      "The database action could not be confirmed. Check its request before retrying.",
    );
  }
}
/** Claims a new operation only; crashed/expired operations never become queued again. */
export async function claimDatabaseAction(
  database: typeof db,
): Promise<DatabaseClaim | null> {
  try {
    // Idle polling must not compete with an owner's next action for every global
    // queue. The authoritative claim is still rechecked under the ordered locks.
    const [pending] = await database
      .select({ id: appDatabaseOperations.id })
      .from(appDatabaseOperations)
      .where(eq(appDatabaseOperations.status, "queued"))
      .limit(1);
    if (!pending) return null;
    return await database.transaction(async (transaction) => {
      await lockDatabaseQueues(transaction);
      const [busy] = await transaction
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(eq(appDatabaseOperations.status, "running"))
        .limit(1);
      if (busy) return null;
      const [operation] = await transaction
        .select()
        .from(appDatabaseOperations)
        .where(eq(appDatabaseOperations.status, "queued"))
        .orderBy(asc(appDatabaseOperations.createdAt))
        .limit(1)
        .for("update");
      if (!operation) return null;
      try {
        await requireProjectCapability(
          transaction,
          operation.projectId,
          operation.actorId,
          "manage",
        );
      } catch (error) {
        if (
          !(error instanceof ProjectAccessError) &&
          !(error instanceof AccessDeniedError)
        )
          throw error;
        await transaction
          .update(appDatabaseOperations)
          .set({
            status: "failed",
            errorCode: "ACTOR_ACCESS_CHANGED",
            completedAt: new Date(),
          })
          .where(eq(appDatabaseOperations.id, operation.id));
        const [resource] = await transaction
          .select()
          .from(appDatabases)
          .where(eq(appDatabases.id, operation.databaseId))
          .for("update");
        if (resource)
          await transaction
            .update(appDatabases)
            .set({
              status: operation.kind === "create" ? "failed" : resource.status,
              revision: crypto.randomUUID(),
              errorCode: "ACTOR_ACCESS_CHANGED",
              updatedAt: new Date(),
            })
            .where(eq(appDatabases.id, resource.id));
        return null;
      }
      await requireDatabaseProjectIdle(transaction, operation.projectId);
      const token = crypto.randomUUID();
      await transaction
        .update(appDatabaseOperations)
        .set({
          status: "running",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS),
        })
        .where(eq(appDatabaseOperations.id, operation.id));
      return {
        id: operation.id,
        resourceId: operation.databaseId,
        projectId: operation.projectId,
        token,
      };
    });
  } catch {
    throw new AppDatabaseError(
      503,
      "Database execution could not be claimed safely.",
    );
  }
}
/** Fenced operation read used before every Docker/provider effect. */
export async function loadDatabaseExecution(
  database: typeof db,
  claim: DatabaseClaim,
  dataDirectory: string,
): Promise<{
  operation: typeof appDatabaseOperations.$inferSelect;
  resource: typeof appDatabases.$inferSelect;
  credentials: DatabaseCredentials;
}> {
  try {
    const [row] = await database
      .select({ operation: appDatabaseOperations, resource: appDatabases })
      .from(appDatabaseOperations)
      .innerJoin(
        appDatabases,
        eq(appDatabases.id, appDatabaseOperations.databaseId),
      )
      .where(
        and(
          eq(appDatabaseOperations.id, claim.id),
          eq(appDatabaseOperations.projectId, claim.projectId),
          eq(appDatabaseOperations.databaseId, claim.resourceId),
          eq(appDatabaseOperations.claimToken, claim.token),
          eq(appDatabaseOperations.status, "running"),
        ),
      );
    if (
      !row?.operation.leaseExpiresAt ||
      row.operation.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new Error("Database lease expired.");
    const access = await readProjectCapabilities(
      database,
      claim.projectId,
      row.operation.actorId,
    );
    if (!access?.manage) throw new Error("Database owner authority changed.");
    const key = await loadDatabaseKey(
      join(dataDirectory, "database-keys"),
      true,
    );
    return {
      ...row,
      credentials: DatabaseCredentials.parse(
        JSON.parse(
          decryptDatabaseSecret(
            row.resource.secrets,
            key,
            `${row.resource.id}:${row.resource.environment}`,
          ),
        ),
      ),
    };
  } catch {
    throw new AppDatabaseError(
      409,
      "Database execution no longer has a valid lease or authenticated credentials.",
    );
  }
}
export async function renewDatabaseAction(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    const rows = await database
      .update(appDatabaseOperations)
      .set({ leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS) })
      .where(
        and(
          eq(appDatabaseOperations.id, claim.id),
          eq(appDatabaseOperations.claimToken, claim.token),
          eq(appDatabaseOperations.status, "running"),
          gt(appDatabaseOperations.leaseExpiresAt, new Date()),
        ),
      )
      .returning({ id: appDatabaseOperations.id });
    if (!rows.length) throw new Error("Lease lost");
  } catch {
    throw new AppDatabaseError(
      409,
      "The database execution lease is no longer held.",
    );
  }
}
/** Startup crash recovery is an interrupted fence, never an automatic retry. */
export async function interruptExpiredDatabaseActions(
  database: typeof db,
): Promise<void> {
  try {
    const [pending] = await database
      .select({ id: appDatabaseOperations.id })
      .from(appDatabaseOperations)
      .where(
        and(
          eq(appDatabaseOperations.status, "running"),
          or(
            isNull(appDatabaseOperations.leaseExpiresAt),
            lte(appDatabaseOperations.leaseExpiresAt, new Date()),
          ),
        ),
      )
      .limit(1);
    if (!pending) return;
    await database.transaction(async (transaction) => {
      await lockDatabaseQueues(transaction);
      const expired = await transaction
        .update(appDatabaseOperations)
        .set({
          status: "interrupted",
          claimToken: null,
          leaseExpiresAt: null,
          errorCode: "EXECUTION_INTERRUPTED",
        })
        .where(
          and(
            eq(appDatabaseOperations.status, "running"),
            or(
              isNull(appDatabaseOperations.leaseExpiresAt),
              lte(appDatabaseOperations.leaseExpiresAt, new Date()),
            ),
          ),
        )
        .returning({ id: appDatabaseOperations.databaseId, kind: appDatabaseOperations.kind });
      // Disposable validation never touched the real database. Its interrupted
      // operation still blocks work, without falsely changing the resource state.
      const persistent = expired.filter(row => !["validate-application", "recover-validation"].includes(row.kind));
      if (persistent.length)
        await transaction
          .update(appDatabases)
          .set({
            status: "recovery_required",
            revision: crypto.randomUUID(),
            errorCode: "EXECUTION_INTERRUPTED",
            updatedAt: new Date(),
          })
          .where(
            inArray(
              appDatabases.id,
              persistent.map((row) => row.id),
            ),
          );
    });
  } catch {
    throw new AppDatabaseError(
      503,
      "Database crash recovery could not be recorded.",
    );
  }
}
/** Startup preflight never applies a migration to the operator database. */
export async function verifyDatabaseSchema(database: typeof db): Promise<void> {
  try {
    await database.select().from(appDatabases).limit(1);
    await database.select().from(appDatabaseOperations).limit(1);
    await database.select().from(appDatabaseMigrations).limit(1);
    await database.select().from(appDatabaseBackups).limit(1);
  } catch {
    throw new Error(
      "Application database persistence is unavailable. Run bun run db:migrate from packages/db (through 0025_app-database-migration-review) before startup.",
    );
  }
}

/** Shared claim identity/expiry predicate for mutation and bounded read executors. */
export function heldClaim(claim: DatabaseClaim): ReturnType<typeof and> {
  return and(
    eq(appDatabaseOperations.id, claim.id),
    eq(appDatabaseOperations.databaseId, claim.resourceId),
    eq(appDatabaseOperations.projectId, claim.projectId),
    eq(appDatabaseOperations.claimToken, claim.token),
    eq(appDatabaseOperations.status, "running"),
    gt(appDatabaseOperations.leaseExpiresAt, new Date()),
  );
}

/** Cleanup remains lease-bound even when an operation's user-facing signal is cancelled. */
export async function assertDatabaseCleanupLease(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  const [operation] = await database
    .select({ id: appDatabaseOperations.id })
    .from(appDatabaseOperations)
    .where(heldClaim(claim))
    .limit(1);
  if (!operation)
    throw new AppDatabaseError(
      409,
      "Database cleanup lease is no longer held.",
    );
}

/** Saves cleanup separately: uncertain SQL is never erased or falsely acknowledged. */
export async function recordDatabaseCleanupEffect(
  database: typeof db,
  claim: DatabaseClaim,
  effect: { kind: "terminate-sessions" | "close-reader-socket" | "cleanup-read-runtime"; id: string },
): Promise<void> {
  try {
    let recoveredReadId: string | undefined;
    if (effect.kind === "cleanup-read-runtime") {
      const [operation] = await database.select({ kind: appDatabaseOperations.kind, effect: appDatabaseOperations.effect })
        .from(appDatabaseOperations).where(heldClaim(claim));
      if (operation?.kind === "recover-read" && operation.effect?.kind === "inspect-read-operation") {
        const [target] = await database.select({ id: appDatabaseOperations.id }).from(appDatabaseOperations)
          .where(and(eq(appDatabaseOperations.id, operation.effect.id), eq(appDatabaseOperations.kind, "read"),
            eq(appDatabaseOperations.databaseId, claim.resourceId), eq(appDatabaseOperations.projectId, claim.projectId),
            eq(appDatabaseOperations.status, "interrupted")));
        recoveredReadId = target?.id;
      }
    }
    if (
      !((effect.kind === "cleanup-read-runtime" && recoveredReadId !== undefined && effect.id === `wrenly-database-read-${recoveredReadId}`) ||
        (effect.kind === "terminate-sessions" && effect.id === `wrenly-database-administrator-${claim.id}`) ||
        (effect.kind === "close-reader-socket" && effect.id === `wrenly-database-socket-${claim.id}`))
    )
      throw new Error("Invalid cleanup identity");
    const rows = await database
      .update(appDatabaseOperations)
      .set({
        cleanupEffect: { ...effect, startedAt: new Date().toISOString() },
      })
      .where(and(heldClaim(claim), isNull(appDatabaseOperations.cleanupEffect)))
      .returning({ id: appDatabaseOperations.id });
    if (!rows.length)
      throw new Error("Cleanup lease lost or intent unresolved");
  } catch {
    throw new AppDatabaseError(
      409,
      "Database cleanup intent could not be confirmed.",
    );
  }
}

/** Confirms cleanup alone; the primary operation's unknown outcome stays untouched. */
export async function acknowledgeDatabaseCleanupEffect(
  database: typeof db,
  claim: DatabaseClaim,
  effectId: string,
): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .for("update");
      if (!operation?.cleanupEffect || operation.cleanupEffect.id !== effectId)
        throw new Error("Cleanup intent is not held");
      const updated = await tx
        .update(appDatabaseOperations)
        .set({
          cleanupEffect: null,
          completedCleanupEffects: [
            ...operation.completedCleanupEffects,
            operation.cleanupEffect,
          ],
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (!updated.length) throw new Error("Cleanup lease expired");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Database cleanup acknowledgement could not be confirmed.",
    );
  }
}

/** Commits mutation intent before a worker contacts Docker or a provider. Unknown effects retain this fence. */
export async function recordDatabaseEffect(
  database: typeof db,
  claim: DatabaseClaim,
  effect: {
    kind:
      | "create-network"
      | "create-volume"
      | "initialize"
      | "create-container"
      | "create-socket"
      | "provision-roles"
      | "read-database"
      | "apply-migrations"
      | "enforce-policy"
      | "terminate-sessions"
      | "inspect-schema"
      | "capture-backup"
      | "restore-backup"
      | "prepare-validation-artifact"
      | "start"
      | "stop"
      | "migrate";
    id: string;
  },
): Promise<void> {
  try {
    if (!effect.id || effect.id.length > 256 || /[\r\n\0]/.test(effect.id))
      throw new Error("Invalid effect identity");
    const rows = await database
      .update(appDatabaseOperations)
      .set({ effect: { ...effect, startedAt: new Date().toISOString() } })
      .where(
        and(
          heldClaim(claim),
          isNull(appDatabaseOperations.effect),
          isNull(appDatabaseOperations.cleanupEffect),
        ),
      )
      .returning({ id: appDatabaseOperations.id });
    if (!rows.length) throw new Error("Lease lost or effect unresolved");
  } catch {
    throw new AppDatabaseError(
      409,
      "Database mutation intent could not be confirmed. Do not perform the external action.",
    );
  }
}

/** Saves a verified external identity and clears its intent in the same fenced transaction. */
export async function acknowledgeDatabaseEffect(
  database: typeof db,
  claim: DatabaseClaim,
  effectId: string,
  runtimeIdentity?: NonNullable<
    typeof appDatabases.$inferSelect.runtimeIdentity
  >,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .for("update");
      if (
        !operation?.effect ||
        operation.effect.id !== effectId ||
        operation.cleanupEffect
      )
        throw new Error("Effect is not held");
      if (runtimeIdentity && ["validate-application", "recover-validation"].includes(operation.kind))
        throw new Error("Disposable validation cannot replace the real database identity");
      if (runtimeIdentity)
        await transaction
          .update(appDatabases)
          .set({ runtimeIdentity, updatedAt: new Date() })
          .where(
            and(
              eq(appDatabases.id, claim.resourceId),
              eq(appDatabases.projectId, claim.projectId),
            ),
          );
      const updated = await transaction
        .update(appDatabaseOperations)
        .set({
          effect: null,
          completedEffects: [...operation.completedEffects, operation.effect],
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (!updated.length)
        throw new Error("Lease expired during acknowledgement");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "The database effect could not be acknowledged. Reconcile its saved identity before continuing.",
    );
  }
}

/** Finishes only an effect-free leased action; uncertainty must use interruption instead. */
export async function finishDatabaseAction(
  database: typeof db,
  claim: DatabaseClaim,
  outcome:
    | { success: true }
    | {
        success: false;
        errorCode: "PREREQUISITE_UNAVAILABLE" | "VERIFIED_OPERATION_FAILED";
      },
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const [operation] = await transaction
        .select()
        .from(appDatabaseOperations)
        .where(
          and(
            heldClaim(claim),
            isNull(appDatabaseOperations.effect),
            isNull(appDatabaseOperations.cleanupEffect),
          ),
        )
        .for("update");
      if (!operation) throw new Error("No finishable action");
      if (
        !outcome.success &&
        outcome.errorCode === "PREREQUISITE_UNAVAILABLE" &&
        operation.completedEffects.length
      )
        throw new Error(
          "Prerequisite failure cannot follow an acknowledged external effect",
        );
      const [resource] = await transaction
        .select()
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.id, claim.resourceId),
            eq(appDatabases.projectId, claim.projectId),
          ),
        )
        .for("update");
      if (
        !resource ||
        (operation.kind !== "create" &&
          resource.revision !== operation.expectedRevision)
      )
        throw new Error("Resource changed");
      if (outcome.success && !resource.runtimeIdentity)
        throw new Error("Missing verified runtime identity");
      if (
        outcome.success &&
        operation.kind === "create" &&
        !operation.completedEffects.some(
          (effect) => effect.kind === "provision-roles",
        )
      )
        throw new Error("Application roles have not been provisioned.");
      if (
        !outcome.success &&
        operation.kind === "create" &&
        operation.completedEffects.length
      )
        throw new Error("Partial provisioning requires reconciliation");
      if (outcome.success && operation.kind === "backup") {
        const [backup] = await transaction
          .select({ id: appDatabaseBackups.id })
          .from(appDatabaseBackups)
          .where(
            and(
              eq(appDatabaseBackups.operationId, claim.id),
              eq(appDatabaseBackups.databaseId, claim.resourceId),
              isNotNull(appDatabaseBackups.verifiedAt),
            ),
          );
        if (!backup)
          throw new Error(
            "A restored, verified backup is required before reporting success",
          );
      }
      if (["validate-application", "recover-validation"].includes(operation.kind))
        throw new Error("Disposable validation requires its separate completion protocol");
      let migrationSchemaDigest: string | undefined;
      if (operation.kind === "migrate") {
        const [review] = await transaction
          .select()
          .from(appDatabaseMigrations)
          .where(
            and(
              eq(appDatabaseMigrations.operationId, claim.id),
              eq(appDatabaseMigrations.databaseId, claim.resourceId),
            ),
          );
        if (
          !outcome.success ||
          !review?.completedAt ||
          !review.rehearsedSchemaDigest ||
          review.digest !== operation.migrationDigest ||
          !operation.completedEffects.some(
            (effect) => effect.kind === "apply-migrations",
          ) ||
          !operation.completedEffects.some(
            (effect) => effect.kind === "enforce-policy",
          ) ||
          !operation.completedCleanupEffects.some(
            (effect) => effect.kind === "terminate-sessions",
          )
        )
          throw new Error("Persistent migration has not been verified");
        migrationSchemaDigest = review.rehearsedSchemaDigest;
      }
      const errorCode = outcome.success ? null : outcome.errorCode;
      const updated = await transaction
        .update(appDatabaseOperations)
        .set({
          status: outcome.success ? "success" : "failed",
          claimToken: null,
          leaseExpiresAt: null,
          errorCode,
          completedAt: new Date(),
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (!updated.length) throw new Error("Lease expired during completion");
      await transaction
        .update(appDatabases)
        .set({
          status: outcome.success
            ? operation.kind === "stop"
              ? "stopped"
              : "ready"
            : operation.kind === "create"
              ? "failed"
              : resource.status,
          revision: crypto.randomUUID(),
          errorCode,
          ...(migrationSchemaDigest
            ? { schemaDigest: migrationSchemaDigest }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(appDatabases.id, claim.resourceId));
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Database completion could not be confirmed. Check the saved operation before retrying.",
    );
  }
}

/** A failed/expired executor may record interruption, but can never claim success or restart external work. */
export async function interruptDatabaseAction(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const rows = await transaction
        .update(appDatabaseOperations)
        .set({
          status: "interrupted",
          claimToken: null,
          leaseExpiresAt: null,
          errorCode: "EXECUTION_INTERRUPTED",
        })
        .where(
          and(
            eq(appDatabaseOperations.id, claim.id),
            eq(appDatabaseOperations.databaseId, claim.resourceId),
            eq(appDatabaseOperations.projectId, claim.projectId),
            eq(appDatabaseOperations.claimToken, claim.token),
            eq(appDatabaseOperations.status, "running"),
          ),
        )
        .returning({ id: appDatabaseOperations.databaseId, kind: appDatabaseOperations.kind });
      if (rows.length && !["validate-application", "recover-validation"].includes(rows[0]?.kind ?? ""))
        await transaction
          .update(appDatabases)
          .set({
            status: "recovery_required",
            revision: crypto.randomUUID(),
            errorCode: "EXECUTION_INTERRUPTED",
            updatedAt: new Date(),
          })
          .where(eq(appDatabases.id, claim.resourceId));
    });
  } catch {
    throw new AppDatabaseError(
      503,
      "Database interruption could not be recorded. Do not admit another operation.",
    );
  }
}

/** Cheap authority fence used during readiness checks; credentials are decrypted only for execution setup. */
export async function assertDatabaseExecution(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    const [operation] = await database
      .select({ actorId: appDatabaseOperations.actorId })
      .from(appDatabaseOperations)
      .where(heldClaim(claim));
    if (
      !operation ||
      !(
        await readProjectCapabilities(
          database,
          claim.projectId,
          operation.actorId,
        )
      )?.manage
    )
      throw new Error("Database authority or lease lost");
  } catch {
    throw new AppDatabaseError(
      409,
      "Database execution no longer has current owner authority and a valid lease.",
    );
  }
}

/** Records a backup only after authenticated decryption, isolated restore/schema verification and temporary cleanup. */
export async function saveVerifiedDatabaseBackup(
  database: typeof db,
  claim: DatabaseClaim,
  input: { sha256: string; encryptedPath: string; schemaDigest: string },
): Promise<void> {
  if (
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    !/^[a-f0-9]{64}$/.test(input.schemaDigest) ||
    input.encryptedPath !==
      `database-backups/${claim.resourceId}/${claim.id}.wdb`
  )
    throw new AppDatabaseError(400, "Invalid verified backup identity");
  await database.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          heldClaim(claim),
          isNull(appDatabaseOperations.effect),
          isNull(appDatabaseOperations.cleanupEffect),
        ),
      )
      .for("update");
    if (
      !operation ||
      operation.kind !== "backup" ||
      !operation.completedEffects.some(
        (effect) => effect.kind === "restore-backup",
      )
    )
      throw new AppDatabaseError(409, "Backup verification is not complete");
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(eq(appDatabases.id, claim.resourceId))
      .for("update");
    if (!resource || resource.revision !== operation.expectedRevision)
      throw new AppDatabaseError(
        409,
        "Database changed during backup verification",
      );
    await tx.insert(appDatabaseBackups).values({
      id: claim.id,
      databaseId: claim.resourceId,
      operationId: claim.id,
      ...input,
      verifiedAt: new Date(),
    });
  });
}

/** Reloads the immutable review and exact source under the active execution lease. */
export async function loadDatabaseMigrationReview(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<{
  review: typeof appDatabaseMigrations.$inferSelect;
  backup: typeof appDatabaseBackups.$inferSelect;
  files: Array<{ path: string; content: string }>;
  framework: "nextjs" | "laravel";
}> {
  const [row] = await database
    .select({
      operation: appDatabaseOperations,
      review: appDatabaseMigrations,
      backup: appDatabaseBackups,
      build: builds,
    })
    .from(appDatabaseOperations)
    .innerJoin(
      appDatabaseMigrations,
      eq(appDatabaseMigrations.operationId, appDatabaseOperations.id),
    )
    .innerJoin(
      appDatabaseBackups,
      eq(appDatabaseBackups.id, appDatabaseMigrations.backupId),
    )
    .innerJoin(builds, eq(builds.id, appDatabaseMigrations.buildId))
    .where(heldClaim(claim));
  if (
    !row ||
    row.operation.kind !== "migrate" ||
    row.operation.migrationDigest !== row.review.digest ||
    row.operation.buildId !== row.build.id ||
    row.build.projectId !== claim.projectId ||
    (row.build.stack !== "nextjs" && row.build.stack !== "laravel") ||
    row.build.status !== "success" ||
    row.review.databaseId !== claim.resourceId ||
    row.backup.databaseId !== claim.resourceId ||
    !row.backup.verifiedAt ||
    row.review.beforeSchemaDigest !== row.backup.schemaDigest ||
    !row.review.beforeSchemaDigest ||
    row.review.completedAt
  )
    throw new AppDatabaseError(
      409,
      "The frozen migration review or verified backup no longer matches.",
    );
  return {
    review: row.review,
    backup: row.backup,
    files: readFrozenMigrationSource(row.build.files, row.review.digest, row.build.stack).files,
    framework: row.build.stack,
  };
}

/** Records the native verified schema only after primary effects and cancellation cleanup are acknowledged. */
export async function saveDatabaseMigrationRehearsal(
  database: typeof db,
  claim: DatabaseClaim,
  schemaDigest: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(schemaDigest))
    throw new AppDatabaseError(409, "Invalid rehearsal schema digest.");
  await database.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          heldClaim(claim),
          isNull(appDatabaseOperations.effect),
          isNull(appDatabaseOperations.cleanupEffect),
        ),
      )
      .for("update");
    if (!operation || operation.kind !== "migrate")
      throw new AppDatabaseError(409, "Rehearsal effects are not settled.");
    const updated = await tx
      .update(appDatabaseMigrations)
      .set({ rehearsedSchemaDigest: schemaDigest })
      .where(
        and(
          eq(appDatabaseMigrations.operationId, claim.id),
          eq(appDatabaseMigrations.databaseId, claim.resourceId),
          isNull(appDatabaseMigrations.rehearsedSchemaDigest),
          isNull(appDatabaseMigrations.completedAt),
        ),
      )
      .returning({ id: appDatabaseMigrations.id });
    if (updated.length !== 1)
      throw new AppDatabaseError(
        409,
        "Rehearsal verification could not be saved.",
      );
  });
}

/** Marks completion only when the persistent schema matches the saved rehearsal. */
export async function saveVerifiedDatabaseMigration(
  database: typeof db,
  claim: DatabaseClaim,
  schemaDigest: string,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(schemaDigest))
    throw new AppDatabaseError(409, "Invalid verified schema digest.");
  await database.transaction(async (tx) => {
    const [operation] = await tx
      .select()
      .from(appDatabaseOperations)
      .where(
        and(
          heldClaim(claim),
          isNull(appDatabaseOperations.effect),
          isNull(appDatabaseOperations.cleanupEffect),
        ),
      )
      .for("update");
    if (!operation || operation.kind !== "migrate")
      throw new AppDatabaseError(409, "Migration effects are not settled.");
    const updated = await tx
      .update(appDatabaseMigrations)
      .set({ completedAt: new Date() })
      .where(
        and(
          eq(appDatabaseMigrations.operationId, claim.id),
          eq(appDatabaseMigrations.databaseId, claim.resourceId),
          eq(appDatabaseMigrations.digest, operation.migrationDigest ?? ""),
          eq(appDatabaseMigrations.rehearsedSchemaDigest, schemaDigest),
          isNull(appDatabaseMigrations.completedAt),
        ),
      )
      .returning({ id: appDatabaseMigrations.id });
    if (updated.length !== 1)
      throw new AppDatabaseError(
        409,
        "Migration verification could not be saved.",
      );
  });
}
