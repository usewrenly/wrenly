/**
 * COMPONENT: Database reader lease
 * PURPOSE: Keep socket reads visible to resource writes, access changes and crash recovery.
 * INPUTS: Verified actor, exact resource revision and bounded read request.
 * OUTPUTS: A short-lived running read claim; no rows or credentials are persisted.
 * STEPS: Lock queues/account/project, recheck authority, exclude conflicting work,
 * save one read claim, and finish only after every helper effect is acknowledged.
 * EDGE CASES: Reads never join the queued mutation worker or replay saved rows.
 * ERROR STATES: Expired claims/unknown effects remain interrupted for explicit cleanup.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appDatabases, appDatabaseOperations, type db } from "@wrenly/db";
import { requireProjectCapability } from "../../projects/access/project-access";
import { AppDatabaseError, DatabaseCredentials } from "../database-contract";
import {
  DATABASE_LEASE_MS,
  hasDatabaseWork,
  heldClaim,
  lockDatabaseQueues,
  type DatabaseClaim,
} from "../database-store";
import { loadDatabaseKey, decryptDatabaseSecret } from "../database-secrets";
import {
  readDatabaseViewAuthority,
  type DatabaseViewAuthority,
} from "./view-authority";
import { DatabaseViewRequest } from "./view-contract";

const MAX_ACTIVE_READS = 4;
export interface DatabaseReadClaim extends DatabaseClaim {
  actorId: string;
  request: DatabaseViewRequest;
  authority: DatabaseViewAuthority;
}

/** Read claims start running immediately; rows and query results never enter control storage. */
export async function beginDatabaseRead(
  database: typeof db,
  projectId: string,
  actorId: string,
  value: unknown,
): Promise<DatabaseReadClaim> {
  const parsed = DatabaseViewRequest.safeParse(value);
  if (!parsed.success)
    throw new AppDatabaseError(
      400,
      "Choose an explicit database revision and view.",
    );
  const request = Object.freeze(parsed.data);
  try {
    return await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "read");
      const authority = await readDatabaseViewAuthority(
        tx,
        projectId,
        actorId,
        request,
      );
      if (await hasDatabaseWork(tx, projectId))
        throw new AppDatabaseError(
          409,
          "Finish or reconcile the current database operation before inspecting data.",
        );
      const active = await tx
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.kind, "read"),
            inArray(appDatabaseOperations.status, ["running", "interrupted"]),
          ),
        )
        .limit(MAX_ACTIVE_READS);
      if (active.length >= MAX_ACTIVE_READS)
        throw new AppDatabaseError(
          429,
          "Database inspection is busy. Try again shortly.",
        );
      const id = crypto.randomUUID(),
        token = crypto.randomUUID();
      await tx.insert(appDatabaseOperations).values({
        id,
        databaseId: request.resourceId,
        projectId,
        actorId,
        requestId: crypto.randomUUID(),
        kind: "read",
        status: "running",
        expectedRevision: request.revision,
        claimToken: token,
        leaseExpiresAt: new Date(Date.now() + DATABASE_LEASE_MS),
        requestIdentity: createHash("sha256")
          .update(JSON.stringify([projectId, actorId, request]))
          .digest("hex"),
      });
      return {
        id,
        token,
        resourceId: request.resourceId,
        projectId,
        actorId,
        request,
        authority,
      };
    });
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "Database inspection could not be admitted. Reload its current status.",
    );
  }
}

/** Fence rechecks include authority, not just the existence of a claim token. */
export async function assertDatabaseRead(
  database: typeof db,
  claim: DatabaseReadClaim,
): Promise<void> {
  try {
    const [operation] = await database
      .select({
        actorId: appDatabaseOperations.actorId,
        revision: appDatabaseOperations.expectedRevision,
      })
      .from(appDatabaseOperations)
      .where(and(heldClaim(claim), eq(appDatabaseOperations.kind, "read")));
    if (
      !operation ||
      operation.actorId !== claim.actorId ||
      operation.revision !== claim.request.revision
    )
      throw new AppDatabaseError(
        409,
        "The database read lease is no longer valid.",
      );
    const current = await readDatabaseViewAuthority(
      database,
      claim.projectId,
      claim.actorId,
      claim.request,
    );
    if (
      current.accessRevision !== claim.authority.accessRevision ||
      current.resourceRevision !== claim.authority.resourceRevision
    )
      throw new AppDatabaseError(
        409,
        "Project access or database state changed during inspection.",
      );
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "The database read lease could not be checked.",
    );
  }
}

/** Only the reader credential leaves this function, and only after a current lease/access check. */
export async function loadDatabaseReadConnection(
  database: typeof db,
  claim: DatabaseReadClaim,
  directory: string,
): Promise<{
  identity: NonNullable<typeof appDatabases.$inferSelect.runtimeIdentity>;
  role: { user: string; password: string };
}> {
  try {
    await assertDatabaseRead(database, claim);
    const [resource] = await database
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, claim.resourceId),
          eq(appDatabases.projectId, claim.projectId),
          eq(appDatabases.environment, claim.request.environment),
          eq(appDatabases.revision, claim.request.revision),
        ),
      );
    if (
      !resource?.runtimeIdentity ||
      resource.provider !== "local" ||
      resource.environment !== "development"
    )
      throw new AppDatabaseError(
        409,
        "A supported ready database connection is required for inspection.",
      );
    const key = await loadDatabaseKey(join(directory, "database-keys"), true);
    const credentials = DatabaseCredentials.parse(
      JSON.parse(
        decryptDatabaseSecret(
          resource.secrets,
          key,
          `${resource.id}:${resource.environment}`,
        ),
      ) as unknown,
    );
    await assertDatabaseRead(database, claim);
    return { identity: resource.runtimeIdentity, role: credentials.reader };
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "The private database reader connection is unavailable.",
    );
  }
}

/** Never marks unknown effects complete or changes the resource's schema/runtime revision. */
export async function finishDatabaseRead(
  database: typeof db,
  claim: DatabaseReadClaim,
  success: boolean,
): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(appDatabaseOperations)
        .where(and(heldClaim(claim), eq(appDatabaseOperations.kind, "read")))
        .for("update");
      if (
        !operation ||
        (operation.completedEffects.some(
          (effect) => effect.kind === "create-socket",
        ) &&
          !operation.completedCleanupEffects.some(
            (effect) =>
              effect.kind === "close-reader-socket" &&
              effect.id === `wrenly-database-socket-${claim.id}`,
          ))
      )
        throw new Error("Reader socket closure is not confirmed");
      const rows = await tx
        .update(appDatabaseOperations)
        .set({
          status: success ? "success" : "failed",
          errorCode: success ? null : "READ_FAILED",
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(
          and(
            heldClaim(claim),
            eq(appDatabaseOperations.kind, "read"),
            isNull(appDatabaseOperations.effect),
            isNull(appDatabaseOperations.cleanupEffect),
          ),
        )
        .returning({ id: appDatabaseOperations.id });
      if (!rows.length) throw new Error("Read cleanup is unconfirmed");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Database inspection cleanup could not be confirmed. Reconcile before trying again.",
    );
  }
}
