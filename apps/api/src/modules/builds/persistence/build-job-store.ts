/**
 * Saved build ownership and progress.
 * A worker claim identifies who may update a build; its lease expires unless renewed.
 * Progress/source/events commit together, stale workers cannot write, and interrupted cleanup keeps capacity reserved until recovery.
 */
import {
  ActivityInputSchema,
  type BuildActivityInput,
} from "../http/build-activity";
import {
  readProjectCapabilities,
  unarchivedProjectPredicate,
} from "../../projects/access/project-access";
import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  builds,
  buildJobs,
  buildEvents,
  buildQueue,
  type BuildJobInput,
} from "../../../../../../packages/db/src/schema";
import { logger } from "../../../lib/logger";

const QUEUE_LOCK_ID = 1;
const BUILD_LEASE_MS = 30_000;
const MAX_BUILD_LOG_CHARS = 256_000;
const MAX_GENERATED_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_GENERATED_FILES = 1000;
const MAX_BUILD_ATTEMPTS = 3;
const INTERRUPTED_MESSAGE =
  "Build execution was interrupted. Review the saved files and logs, then retry explicitly.";
const CANCELLED_MESSAGE = "Build cancelled.";
const LOG_TRUNCATION_MARKER = "[Earlier build log truncated]\n";

type JobRow = typeof buildJobs.$inferSelect;
// Shared transaction type preserves Drizzle schema and query typing.
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface BuildClaim {
  buildId: string;
  projectId: string;
  token: string;
  input: BuildJobInput;
}

export type BuildProgress =
  | ({ type: "activity_v1"; attempt: number } & BuildActivityInput)
  | {
      type: "status";
      attempt: number;
      phase: "generating" | "building" | "retrying";
      message: string;
    }
  | {
      type: "file_tree";
      attempt: number;
      files: Array<{ path: string; content: string }>;
    }
  | { type: "log_line"; attempt: number; line: string };

export type BuildOutcome =
  | { status: "success" }
  | { status: "failed"; error: string }
  | { status: "interrupted"; error: string }
  | { status: "cancelled" };

export class BuildClaimLostError extends Error {
  constructor() {
    super("Build execution no longer owns a valid lease.");
    this.name = "BuildClaimLostError";
  }
}

function logStoreFailure(
  message: string,
  error: unknown,
  buildId?: string,
): void {
  // Drizzle errors can embed query parameters, including generated source/secrets.
  logger.error(message, {
    buildId,
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
}

function hasValidClaim(
  job: JobRow | undefined,
  claim: BuildClaim,
  now: Date,
): job is JobRow {
  return Boolean(
    job &&
    job.status === "running" &&
    job.claimToken === claim.token &&
    job.leaseExpiresAt &&
    job.leaseExpiresAt.getTime() > now.getTime(),
  );
}

async function lockClaim(
  transaction: Transaction,
  claim: BuildClaim,
): Promise<JobRow> {
  try {
    const [job] = await transaction
      .select()
      .from(buildJobs)
      .where(eq(buildJobs.buildId, claim.buildId))
      .for("update");
    // Check time after acquiring the lock, since lock contention can outlive a lease.
    if (!hasValidClaim(job, claim, new Date())) throw new BuildClaimLostError();
    return job;
  } catch (error) {
    if (!(error instanceof BuildClaimLostError))
      logStoreFailure("Build job store operation failed", error);
    throw error;
  }
}

async function appendEvent(
  transaction: Transaction,
  job: JobRow,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await transaction.insert(buildEvents).values({
      buildId: job.buildId,
      sequence: job.nextEventSequence,
      type,
      data: { ...data, buildId: job.buildId },
    });
    await transaction
      .update(buildJobs)
      .set({ nextEventSequence: job.nextEventSequence + 1 })
      .where(eq(buildJobs.buildId, job.buildId));
  } catch (error) {
    if (!(error instanceof BuildClaimLostError))
      logStoreFailure("Build job store operation failed", error);
    throw error;
  }
}

/** Claims at most one build globally; expired executions require explicit reconciliation. */
export async function claimNextBuild(
  database: typeof db,
): Promise<BuildClaim | null> {
  try {
    return await database.transaction(async (transaction) => {
      await transaction
        .insert(buildQueue)
        .values({ id: QUEUE_LOCK_ID })
        .onConflictDoNothing();
      await transaction
        .select()
        .from(buildQueue)
        .where(eq(buildQueue.id, QUEUE_LOCK_ID))
        .for("update");
      const [running] = await transaction
        .select({ id: buildJobs.buildId })
        .from(buildJobs)
        .where(eq(buildJobs.status, "running"))
        .limit(1);
      if (running) return null;
      const [job] = await transaction
        .select()
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.status, "queued"),
            unarchivedProjectPredicate(transaction, buildJobs.projectId),
          ),
        )
        .orderBy(asc(buildJobs.createdAt), asc(buildJobs.buildId))
        .limit(1)
        .for("update");
      if (!job) return null;
      const token = crypto.randomUUID();
      await transaction
        .update(buildJobs)
        .set({
          status: "running",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + BUILD_LEASE_MS),
        })
        .where(eq(buildJobs.buildId, job.buildId));
      await transaction
        .update(builds)
        .set({ status: "generating" })
        .where(eq(builds.id, job.buildId));
      await appendEvent(transaction, job, "status", {
        phase: "generating",
        message: "Starting build execution.",
        attempt: 0,
      });
      return {
        buildId: job.buildId,
        projectId: job.projectId,
        token,
        input: job.input,
      };
    });
  } catch (error) {
    logStoreFailure("Build claim failed", error);
    throw error;
  }
}

/** Renews only an unexpired claim; cancellation does not release resources prematurely. */
export async function renewBuildLease(
  database: typeof db,
  claim: BuildClaim,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(buildJobs)
        .where(eq(buildJobs.buildId, claim.buildId))
        .for("update");
      const now = new Date();
      if (!hasValidClaim(job, claim, now)) return false;
      await transaction
        .update(buildJobs)
        .set({ leaseExpiresAt: new Date(now.getTime() + BUILD_LEASE_MS) })
        .where(eq(buildJobs.buildId, job.buildId));
      return true;
    });
  } catch (error) {
    logStoreFailure("Build lease renewal failed", error, claim.buildId);
    throw error;
  }
}

/** Persists progress and its canonical snapshot under the same execution lease. */
export async function recordBuildProgress(
  database: typeof db,
  claim: BuildClaim,
  progress: BuildProgress,
): Promise<void> {
  if (
    !Number.isInteger(progress.attempt) ||
    progress.attempt < 1 ||
    progress.attempt > MAX_BUILD_ATTEMPTS
  )
    throw new Error("Invalid build attempt.");
  if (
    progress.type === "file_tree" &&
    (progress.files.length === 0 ||
      progress.files.length > MAX_GENERATED_FILES ||
      Buffer.byteLength(JSON.stringify(progress.files)) >
        MAX_GENERATED_SOURCE_BYTES)
  )
    throw new Error("Generated source exceeds the build artifact limits.");
  try {
    await database.transaction(async (transaction) => {
      const job = await lockClaim(transaction, claim);
      const [build] = await transaction
        .select()
        .from(builds)
        .where(eq(builds.id, claim.buildId));
      if (!build) throw new BuildClaimLostError();
      if (progress.attempt < build.attemptCount)
        throw new Error("Build attempt cannot move backwards.");
      const patch: Partial<typeof builds.$inferInsert> = {
        attemptCount: progress.attempt,
      };
      let data: Record<string, unknown> = { ...progress };
      if (progress.type === "status") {
        patch.status =
          progress.phase === "building" ? "building" : "generating";
      } else if (progress.type === "file_tree") {
        patch.files = progress.files;
        patch.status = "building";
      } else if (progress.type === "activity_v1") {
        const activity = ActivityInputSchema.parse({
          operation: progress.operation,
          state: progress.state,
        });
        data = {
          ...activity,
          attempt: progress.attempt,
          occurredAt: new Date().toISOString(),
        };
      } else {
        const log = `${build.buildLog ?? ""}${progress.line}\n`;
        const truncated = log.length > MAX_BUILD_LOG_CHARS;
        patch.buildLog = truncated
          ? LOG_TRUNCATION_MARKER +
            log.slice(-(MAX_BUILD_LOG_CHARS - LOG_TRUNCATION_MARKER.length))
          : log;
        // Event payload itself is bounded as well as the snapshot.
        data = {
          attempt: progress.attempt,
          line: progress.line.slice(-MAX_BUILD_LOG_CHARS),
          truncated,
        };
      }
      await transaction
        .update(builds)
        .set(patch)
        .where(eq(builds.id, claim.buildId));
      await appendEvent(transaction, job, progress.type, data);
    });
  } catch (error) {
    if (!(error instanceof BuildClaimLostError))
      logStoreFailure(
        "Build progress persistence failed",
        error,
        claim.buildId,
      );
    throw error;
  }
}

/** Commits one terminal outcome; caller must have stopped all owned execution resources. */
export async function finishBuild(
  database: typeof db,
  claim: BuildClaim,
  outcome: BuildOutcome,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const job = await lockClaim(transaction, claim);
      const [build] = await transaction
        .select()
        .from(builds)
        .where(eq(builds.id, claim.buildId));
      if (!build) throw new BuildClaimLostError();
      if (
        outcome.status === "success" &&
        (build.status !== "building" ||
          !Array.isArray(build.files) ||
          !build.files.length)
      )
        throw new Error(
          "A successful build requires generated source and sandbox validation.",
        );
      const error =
        outcome.status === "success"
          ? null
          : outcome.status === "cancelled"
            ? CANCELLED_MESSAGE
            : outcome.error.slice(-MAX_BUILD_LOG_CHARS);
      const completedAt = new Date();
      await transaction
        .update(builds)
        .set({
          status: outcome.status === "success" ? "success" : "failed",
          errorMessage: error,
          completedAt,
        })
        .where(eq(builds.id, claim.buildId));
      await transaction
        .update(buildJobs)
        .set({ status: outcome.status, leaseExpiresAt: null, completedAt })
        .where(eq(buildJobs.buildId, claim.buildId));
      await appendEvent(transaction, job, "complete", {
        success: outcome.status === "success",
        outcome: outcome.status,
        attempt: build.attemptCount,
        buildLog: build.buildLog ?? "",
        ...(error ? { error } : {}),
      });
    });
  } catch (error) {
    if (!(error instanceof BuildClaimLostError))
      logStoreFailure("Build completion failed", error, claim.buildId);
    throw error;
  }
}

/** Records cancellation intent; running work remains exclusive until executor cleanup. */
export async function requestBuildCancellation(
  database: typeof db,
  buildId: string,
  userId: string,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(buildJobs)
        .where(and(eq(buildJobs.buildId, buildId)))
        .for("update");
      if (!job) return false;
      const permission = await readProjectCapabilities(
        transaction,
        job.projectId,
        userId,
      );
      if (
        !permission?.contribute ||
        (permission.role !== "owner" && job.userId !== userId)
      )
        return false;
      if (job.status !== "queued" && job.status !== "running") return true;
      if (job.cancelRequestedAt) return true;
      const now = new Date();
      await transaction
        .update(buildJobs)
        .set({ cancelRequestedAt: now })
        .where(eq(buildJobs.buildId, buildId));
      if (job.status === "queued") {
        // Queued work has no executing resource, so it can terminate immediately.
        await transaction
          .update(buildJobs)
          .set({ status: "cancelled", completedAt: now })
          .where(eq(buildJobs.buildId, buildId));
        await transaction
          .update(builds)
          .set({
            status: "failed",
            completedAt: now,
            errorMessage: CANCELLED_MESSAGE,
          })
          .where(eq(builds.id, buildId));
        await appendEvent(transaction, job, "complete", {
          success: false,
          outcome: "cancelled",
          attempt: 0,
          error: CANCELLED_MESSAGE,
        });
      }
      return true;
    });
  } catch (error) {
    logStoreFailure("Build cancellation persistence failed", error, buildId);
    throw error;
  }
}

/** Reads persisted cancellation while ensuring the executor still holds its lease. */
export async function isBuildCancellationRequested(
  database: typeof db,
  claim: BuildClaim,
): Promise<boolean> {
  try {
    const [job] = await database
      .select({ cancelRequestedAt: buildJobs.cancelRequestedAt })
      .from(buildJobs)
      .where(
        and(
          eq(buildJobs.buildId, claim.buildId),
          eq(buildJobs.status, "running"),
          eq(buildJobs.claimToken, claim.token),
          gt(buildJobs.leaseExpiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!job) throw new BuildClaimLostError();
    return Boolean(job.cancelRequestedAt);
  } catch (error) {
    if (!(error instanceof BuildClaimLostError))
      logStoreFailure("Build job store operation failed", error);
    throw error;
  }
}

/** Cleans expired claim resources before releasing capacity; never requeues model work. */
export async function reconcileExpiredBuild(
  database: typeof db,
  cleanup: (claim: BuildClaim) => Promise<void>,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      const [job] = await transaction
        .select()
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.status, "running"),
            lte(buildJobs.leaseExpiresAt, new Date()),
          ),
        )
        .orderBy(asc(buildJobs.leaseExpiresAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!job || !job.claimToken) return false;
      await cleanup({
        buildId: job.buildId,
        projectId: job.projectId,
        token: job.claimToken,
        input: job.input,
      });
      const [build] = await transaction
        .select()
        .from(builds)
        .where(eq(builds.id, job.buildId));
      if (!build) throw new Error("Interrupted build snapshot is missing.");
      const completedAt = new Date();
      await transaction
        .update(buildJobs)
        .set({ status: "interrupted", completedAt, leaseExpiresAt: null })
        .where(eq(buildJobs.buildId, job.buildId));
      await transaction
        .update(builds)
        .set({
          status: "failed",
          completedAt,
          errorMessage: INTERRUPTED_MESSAGE,
        })
        .where(eq(builds.id, job.buildId));
      await appendEvent(transaction, job, "complete", {
        success: false,
        outcome: "interrupted",
        attempt: build.attemptCount,
        error: INTERRUPTED_MESSAGE,
        buildLog: build.buildLog ?? "",
      });
      return true;
    });
  } catch (error) {
    logStoreFailure("Expired build reconciliation failed", error);
    throw error;
  }
}
