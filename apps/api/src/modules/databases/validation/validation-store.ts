/**
 * Build-owned disposable validation admission and authority checks.
 * Frozen inputs live separately from real database identity/schema. Registering an
 * operation does not execute it, and replay never returns permission to rerun it.
 */
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  appDatabases,
  appDatabaseOperations,
  appDatabaseValidations,
  buildJobs,
  builds,
  projects,
  type db,
} from "@wrenly/db";
import {
  readProjectCapabilities,
  requireProjectCapability,
} from "../../projects/access/project-access";
import { AppDatabaseError } from "../database-contract";
import { databaseValidationSourceDigest as fingerprint } from "./source-identity";
import { readFrozenMigrationSource } from "../database-migration-review";
import {
  DATABASE_LEASE_MS,
  lockDatabaseQueues,
  hasDatabaseWork,
  heldClaim,
  type DatabaseClaim,
} from "../database-store";
const MAX_VALIDATION_MS = 300_000;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Input = z
  .object({
    operationId: z.string().uuid(),
    requestId: z.string().uuid(),
    buildId: z.string().uuid(),
    buildToken: z.string().uuid(),
    resourceId: z.string().uuid(),
    resourceRevision: z.string().uuid(),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    migrationDigest: Digest,
    remainingMs: z.number().int().min(1).max(MAX_VALIDATION_MS),
  })
  .strict();
type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Internal build-worker admission only. Caller must already own the prepared image. */
export async function beginDatabaseValidation(
  database: typeof db,
  projectId: string,
  actorId: string,
  value: unknown,
): Promise<DatabaseClaim> {
  return registerDatabaseValidation(database, projectId, actorId, value, false);
}

/** Reserves source and cleanup ownership before any Docker preparation; accepts no preselected image. */
export async function beginDatabaseValidationPreparation(
  database: typeof db,
  projectId: string,
  actorId: string,
  value: unknown,
): Promise<DatabaseClaim> {
  return registerDatabaseValidation(database, projectId, actorId, value, true);
}

async function registerDatabaseValidation(
  database: typeof db,
  projectId: string,
  actorId: string,
  value: unknown,
  ownsArtifact: boolean,
): Promise<DatabaseClaim> {
  try {
    const parsed = ownsArtifact
      ? Input.omit({ imageId: true }).safeParse(value)
      : Input.safeParse(value);
    if (!parsed.success || parsed.data.operationId === parsed.data.resourceId)
      throw new AppDatabaseError(
        400,
        "Review the exact prepared database validation attempt.",
      );
    const input = parsed.data;
    return await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProjectCapability(tx, projectId, actorId, "contribute");
      const [replay] = await tx
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(
          and(
            eq(appDatabaseOperations.actorId, actorId),
            eq(appDatabaseOperations.requestId, input.requestId),
          ),
        )
        .limit(1);
      if (replay)
        throw new AppDatabaseError(
          409,
          "Validation is already recorded. Inspect the saved operation instead of rerunning it.",
        );
      const now = new Date();
      const [job] = await tx
        .select()
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.buildId, input.buildId),
            eq(buildJobs.projectId, projectId),
            eq(buildJobs.userId, actorId),
            eq(buildJobs.status, "running"),
            eq(buildJobs.claimToken, input.buildToken),
            gt(buildJobs.leaseExpiresAt, now),
            isNull(buildJobs.cancelRequestedAt),
          ),
        )
        .for("update");
      const [build] = await tx
        .select()
        .from(builds)
        .where(
          and(
            eq(builds.id, input.buildId),
            eq(builds.projectId, projectId),
            eq(builds.status, "building"),
          ),
        )
        .for("update");
      if (
        !job ||
        !build ||
        (build.stack !== "nextjs" && build.stack !== "laravel") ||
        job.input.stack !== build.stack
      )
        throw new AppDatabaseError(
          409,
          "The parent build no longer owns this validation attempt.",
        );
      const [resource] = await tx
        .select({ id: appDatabases.id })
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.id, input.resourceId),
            eq(appDatabases.projectId, projectId),
            eq(appDatabases.environment, "development"),
            eq(appDatabases.provider, "local"),
            eq(appDatabases.revision, input.resourceRevision),
            eq(appDatabases.status, "ready"),
          ),
        )
        .for("update");
      if (!resource || (await hasDatabaseWork(tx, projectId)))
        throw new AppDatabaseError(
          409,
          "Reload the ready Development resource and resolve existing database work.",
        );
      const [busy] = await tx
        .select({ id: appDatabaseOperations.id })
        .from(appDatabaseOperations)
        .where(
          or(
            inArray(appDatabaseOperations.status, ["queued", "running"]),
            and(
              eq(appDatabaseOperations.kind, "validate-application"),
              eq(appDatabaseOperations.status, "interrupted"),
            ),
          ),
        )
        .limit(1);
      if (busy)
        throw new AppDatabaseError(
          429,
          "Wait for current database work before starting disposable validation.",
        );
      const source = readFrozenMigrationSource(
        build.files,
        input.migrationDigest,
        build.stack,
      );
      const [project] = await tx
        .select({ revision: projects.accessRevision })
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) throw new AppDatabaseError(404, "Project not found.");
      const token = crypto.randomUUID();
      await tx.insert(appDatabaseOperations).values({
        id: input.operationId,
        databaseId: input.resourceId,
        projectId,
        actorId,
        requestId: input.requestId,
        requestIdentity: createHash("sha256")
          .update(JSON.stringify([projectId, input, fingerprint(source.files)]))
          .digest("hex"),
        kind: "validate-application",
        status: "running",
        expectedRevision: input.resourceRevision,
        buildId: input.buildId,
        migrationDigest: input.migrationDigest,
        claimToken: token,
        leaseExpiresAt: new Date(
          now.getTime() + Math.min(DATABASE_LEASE_MS, input.remainingMs),
        ),
      });
      await tx.insert(appDatabaseValidations).values({
        operationId: input.operationId,
        buildId: input.buildId,
        buildToken: input.buildToken,
        accessRevision: project.revision,
        resourceRevision: input.resourceRevision,
        framework: build.stack,
        files: source.files,
        sourceDigest: fingerprint(source.files),
        migrationDigest: input.migrationDigest,
        imageId:
          "imageId" in input && typeof input.imageId === "string"
            ? input.imageId
            : null,
        ownsArtifact,
        deadlineAt: new Date(now.getTime() + input.remainingMs),
      });
      return {
        id: input.operationId,
        projectId,
        resourceId: input.resourceId,
        token,
      };
    });
  } catch (error) {
    if (error instanceof Error && "status" in error) throw error;
    throw new AppDatabaseError(
      409,
      "Database validation could not be registered. Inspect its saved request before retrying.",
    );
  }
}

/** Requires both live claims and current source/access; never exposes frozen files to the browser. */
export async function assertDatabaseValidation(
  database: Database,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    const [row] = await database
      .select({
        validation: appDatabaseValidations,
        actorId: appDatabaseOperations.actorId,
      })
      .from(appDatabaseOperations)
      .innerJoin(
        appDatabaseValidations,
        eq(appDatabaseValidations.operationId, appDatabaseOperations.id),
      )
      .where(
        and(
          heldClaim(claim),
          eq(appDatabaseOperations.kind, "validate-application"),
        ),
      )
      .limit(1);
    if (!row || !["nextjs", "laravel"].includes(row.validation.framework))
      throw new Error("Validation claim lost");
    // Admission/access mutations use the global queues. Execution rechecks rather than
    // assuming that an unexpired database lease also keeps its parent build alive.
    const [job] = await database
      .select({ id: buildJobs.buildId })
      .from(buildJobs)
      .where(
        and(
          eq(buildJobs.buildId, row.validation.buildId),
          eq(buildJobs.projectId, claim.projectId),
          eq(buildJobs.userId, row.actorId),
          eq(buildJobs.status, "running"),
          eq(buildJobs.claimToken, row.validation.buildToken),
          gt(buildJobs.leaseExpiresAt, new Date()),
          isNull(buildJobs.cancelRequestedAt),
        ),
      )
      .limit(1);
    const [source] = await database
      .select({
        files: builds.files,
        framework: builds.stack,
        revision: projects.accessRevision,
        archivedAt: projects.archivedAt,
      })
      .from(builds)
      .innerJoin(projects, eq(projects.id, builds.projectId))
      .where(
        and(
          eq(builds.id, row.validation.buildId),
          eq(builds.projectId, claim.projectId),
          eq(builds.status, "building"),
        ),
      )
      .limit(1);
    const [resource] = await database
      .select({ id: appDatabases.id })
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, claim.resourceId),
          eq(appDatabases.projectId, claim.projectId),
          eq(appDatabases.revision, row.validation.resourceRevision),
          eq(appDatabases.environment, "development"),
          eq(appDatabases.provider, "local"),
          eq(appDatabases.status, "ready"),
        ),
      )
      .limit(1);
    if (
      !job ||
      !source ||
      source.archivedAt ||
      source.revision !== row.validation.accessRevision ||
      source.framework !== row.validation.framework ||
      !resource ||
      row.validation.deadlineAt.getTime() <= Date.now() ||
      fingerprint(
        readFrozenMigrationSource(
          source.files,
          row.validation.migrationDigest,
          row.validation.framework === "laravel" ? "laravel" : "nextjs",
        ).files,
      ) !== row.validation.sourceDigest ||
      fingerprint(row.validation.files) !== row.validation.sourceDigest
    )
      throw new Error("Validation identity changed");
    if (
      !(await readProjectCapabilities(database, claim.projectId, row.actorId))
        ?.contribute
    )
      throw new Error("Validation actor lost access");
  } catch {
    throw new AppDatabaseError(
      409,
      "Database validation ownership, source or deadline changed. Do not start another effect.",
    );
  }
}

/** Renew only while both claims, current authority, frozen source and deadline still agree. */
export async function renewDatabaseValidation(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<void> {
  try {
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [operation] = await tx
        .select({ actorId: appDatabaseOperations.actorId })
        .from(appDatabaseOperations)
        .where(heldClaim(claim))
        .limit(1);
      if (!operation) throw new Error("Validation lease lost");
      await requireProjectCapability(
        tx,
        claim.projectId,
        operation.actorId,
        "contribute",
      );
      await assertDatabaseValidation(tx, claim);
      const [row] = await tx
        .select({ deadlineAt: appDatabaseValidations.deadlineAt })
        .from(appDatabaseValidations)
        .where(eq(appDatabaseValidations.operationId, claim.id));
      if (!row) throw new Error("Validation not found");
      const changed = await tx
        .update(appDatabaseOperations)
        .set({
          leaseExpiresAt: new Date(
            Math.min(Date.now() + DATABASE_LEASE_MS, row.deadlineAt.getTime()),
          ),
        })
        .where(heldClaim(claim))
        .returning({ id: appDatabaseOperations.id });
      if (changed.length !== 1) throw new Error("Validation lease expired");
    });
  } catch {
    throw new AppDatabaseError(
      409,
      "Validation ownership changed; its lease was not renewed.",
    );
  }
}

/** Trusted executor inputs only; the frozen source and image identity never form a public DTO. */
export async function loadDatabaseValidation(
  database: typeof db,
  claim: DatabaseClaim,
): Promise<{
  framework: "nextjs" | "laravel";
  files: Array<{ path: string; content: string }>;
  migrationDigest: string;
  imageId: string | null;
  ownsArtifact: boolean;
  remainingMs: number;
}> {
  try {
    await assertDatabaseValidation(database, claim);
    const [row] = await database
      .select()
      .from(appDatabaseValidations)
      .where(eq(appDatabaseValidations.operationId, claim.id));
    if (!row || (row.framework !== "nextjs" && row.framework !== "laravel"))
      throw new Error("Validation not found");
    await assertDatabaseValidation(database, claim);
    const remainingMs = row.deadlineAt.getTime() - Date.now();
    if (remainingMs < 1) throw new Error("Validation deadline elapsed");
    return {
      framework: row.framework,
      files: row.files,
      migrationDigest: row.migrationDigest,
      imageId: row.imageId,
      ownsArtifact: row.ownsArtifact,
      remainingMs,
    };
  } catch {
    throw new AppDatabaseError(
      409,
      "Frozen database validation inputs are no longer available to this executor.",
    );
  }
}

/** Optional module preflight only; the ordinary API startup does not activate validation. */
export async function verifyDatabaseValidationSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database
      .select({
        id: appDatabaseValidations.operationId,
        ownsArtifact: appDatabaseValidations.ownsArtifact,
      })
      .from(appDatabaseValidations)
      .limit(1);
  } catch {
    throw new Error(
      "Database validation persistence requires migration 0032. Apply checked-in migrations before enabling this module.",
    );
  }
}
