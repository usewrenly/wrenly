/**
 * COMPONENT: Saved build to disposable database validation
 * PURPOSE: Validate the submitting build's saved source without trusting caller-supplied source or actor identity.
 * INPUTS: Live parent claim, explicit Development resource/revision, operation/request IDs and original deadline.
 * OUTPUTS: The saved validation operation and its known success/failure or interrupted outcome.
 * STEPS: Validate selection, read the exact live submitting job and saved framework/source,
 * derive its migration identity, register preparation ownership, then execute that one operation.
 * EDGE CASES: No manifest/resource inference, owner impersonation or fallback revision; exact replay refuses execution.
 * ERROR STATES: Admission failures start no Docker work; interrupted outcomes must stop build repair retries.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { z } from "zod";
import { buildJobs, builds, type db } from "@wrenly/db";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import type { BuildClaim } from "../../builds/persistence/build-job-store";
import { AppDatabaseError } from "../database-contract";
import {
  readDatabaseApplicationSource,
  readFrozenMigrationSource,
} from "../database-migration-review";
import { beginDatabaseValidationPreparation } from "./validation-store";
import {
  executeDatabaseValidation,
  type ValidationExecutionAdapters,
  type ValidationOutcome,
} from "./validation-executor";

const MAX_VALIDATION_MS = 300_000;
const Selection = z
  .object({
    operationId: z.string().uuid(),
    requestId: z.string().uuid(),
    resourceId: z.string().uuid(),
    resourceRevision: z.string().uuid(),
    deadlineAt: z.number().int().positive(),
  })
  .strict();

/** Internal handoff only: the caller must freeze the resource selection at build admission before activation. */
export async function executeDatabaseBuildValidation(
  database: typeof db,
  parent: BuildClaim,
  selection: unknown,
  signal: AbortSignal,
  adapters: ValidationExecutionAdapters = {},
): Promise<{ operationId: string; outcome: ValidationOutcome }> {
  try {
    const input = Selection.safeParse(selection);
    if (!input.success)
      throw new AppDatabaseError(
        400,
        "Choose the exact Development database, code attempt and original deadline.",
      );
    signal.throwIfAborted();
    const now = new Date();
    const remainingMs = input.data.deadlineAt - now.getTime();
    if (remainingMs < 1 || remainingMs > MAX_VALIDATION_MS)
      throw new AppDatabaseError(
        409,
        "The original database validation deadline is no longer available.",
      );
    const [saved] = await database
      .select({
        actorId: buildJobs.userId,
        files: builds.files,
        framework: builds.stack,
        savedInput: buildJobs.input,
      })
      .from(buildJobs)
      .innerJoin(builds, eq(builds.id, buildJobs.buildId))
      .where(
        and(
          eq(buildJobs.buildId, parent.buildId),
          eq(buildJobs.projectId, parent.projectId),
          eq(builds.projectId, parent.projectId),
          eq(builds.status, "building"),
          eq(buildJobs.status, "running"),
          eq(buildJobs.claimToken, parent.token),
          gt(buildJobs.leaseExpiresAt, now),
          isNull(buildJobs.cancelRequestedAt),
        ),
      )
      .limit(1);
    if (
      !saved ||
      (saved.framework !== "nextjs" && saved.framework !== "laravel") ||
      saved.framework !== parent.input.stack
    )
      throw new AppDatabaseError(
        409,
        "The submitting build no longer owns this saved source.",
      );
    const choice = BuildDatabaseSelection.safeParse(
      saved.savedInput.databaseV1,
    );
    const claimedChoice = BuildDatabaseSelection.safeParse(
      parent.input.databaseV1,
    );
    if (
      !choice.success ||
      !claimedChoice.success ||
      choice.data.resourceId !== input.data.resourceId ||
      choice.data.resourceRevision !== input.data.resourceRevision ||
      choice.data.resourceId !== claimedChoice.data.resourceId ||
      choice.data.resourceRevision !== claimedChoice.data.resourceRevision
    )
      throw new AppDatabaseError(
        409,
        "Use the Development database choice saved with this build; it cannot be replaced during execution.",
      );
    // Parse source with the same bounded contract used by admission, never execute it here.
    const files = readDatabaseApplicationSource(saved.files);
    const manifest = readAppDatabaseManifest(files, saved.framework);
    if (!manifest)
      throw new AppDatabaseError(
        409,
        "This saved revision does not declare a supported application database.",
      );
    readFrozenMigrationSource(files, manifest.digest, saved.framework);
    signal.throwIfAborted();
    const claim = await beginDatabaseValidationPreparation(
      database,
      parent.projectId,
      saved.actorId,
      {
        operationId: input.data.operationId,
        requestId: input.data.requestId,
        buildId: parent.buildId,
        buildToken: parent.token,
        resourceId: input.data.resourceId,
        resourceRevision: input.data.resourceRevision,
        migrationDigest: manifest.digest,
        remainingMs: input.data.deadlineAt - Date.now(),
      },
    );
    const outcome = await executeDatabaseValidation(
      database,
      claim,
      signal,
      adapters,
    );
    return { operationId: claim.id, outcome };
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      409,
      "Saved database build validation could not be confirmed. Inspect its operation before another attempt.",
    );
  }
}
