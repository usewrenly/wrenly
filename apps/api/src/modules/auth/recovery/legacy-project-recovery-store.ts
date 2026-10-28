/**
 * Explicit legacy project ownership recovery.
 * Only the verified instance owner may review and confirm selected projects held by the former fixed local identity.
 * Queue locks, expiring reviews, history preservation and active/uncertain-work blockers prevent unsafe transfer.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  builds,
  projects,
  instanceSetup,
  legacyProjectRecovery,
  buildJobs,
  previews,
  previewRequests,
  previewAccess,
  deployments,
  conversations,
  conversationTurns,
  conversationQueue,
  buildQueue,
  previewQueue,
  deploymentQueue,
} from "../../../../../../packages/db/src/schema";
import { logger } from "../../../lib/logger";
const LEGACY_USER_ID = "local-user-wrenly";
const MAX_PROJECTS = 20;
const MAX_INVENTORY = 100;
const MAX_RECORDS = 2000;
const REVIEW_TTL_MS = 10 * 60_000;
const Selection = z
  .object({ projectIds: z.array(z.string().uuid()).min(1).max(MAX_PROJECTS) })
  .strict();
const Confirmation = z
  .object({ reviewId: z.string().uuid(), requestId: z.string().uuid() })
  .strict();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class LegacyRecoveryError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "LegacyRecoveryError";
  }
}
async function operation<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof LegacyRecoveryError) throw error;
    const detail: unknown =
      error instanceof Error && error.cause ? error.cause : error;
    if (
      detail &&
      typeof detail === "object" &&
      "code" in detail &&
      detail.code === "23505"
    )
      throw new LegacyRecoveryError(
        409,
        "A request identity conflicts with another operation. No projects were transferred.",
      );
    logger.error("Legacy project recovery failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new LegacyRecoveryError(
      503,
      "Recovery is unavailable or busy. Retry after active operations finish; check migrations through 0013 if it persists.",
    );
  }
}
async function requireOwner(tx: Transaction, actorId: string): Promise<void> {
  const [setup] = await tx
    .select({ ownerId: instanceSetup.ownerId })
    .from(instanceSetup)
    .where(eq(instanceSetup.id, 1));
  if (
    !setup?.ownerId ||
    setup.ownerId !== actorId ||
    actorId === LEGACY_USER_ID
  )
    throw new LegacyRecoveryError(
      403,
      "Only the verified instance owner can recover legacy projects.",
    );
}
async function lockQueues(tx: Transaction): Promise<void> {
  // Non-waiting acquisition avoids a lock cycle with conversation-triggered build admission.
  for (const table of [
    conversationQueue,
    buildQueue,
    previewQueue,
    deploymentQueue,
  ]) {
    await tx.insert(table).values({ id: 1 }).onConflictDoNothing();
    await tx
      .select()
      .from(table)
      .where(eq(table.id, 1))
      .for("update", { noWait: true });
  }
}
async function inspect(
  tx: Transaction,
  actorId: string,
  projectIds: string[],
): Promise<{
  fingerprint: string;
  blockers: string[];
  selected: Array<{ id: string; name: string }>;
  previewIds: string[];
}> {
  const selected = await tx
    .select({
      id: projects.id,
      name: projects.name,
      userId: projects.userId,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(inArray(projects.id, projectIds))
    .orderBy(asc(projects.id))
    .for("update", { noWait: true });
  if (
    selected.length !== projectIds.length ||
    selected.some((row) => row.userId !== LEGACY_USER_ID)
  )
    throw new LegacyRecoveryError(
      409,
      "The selection changed or contains a project outside legacy recovery. Refresh the list.",
    );
  // Inspect only metadata: generated source and runtime credentials never enter reviews.
  const historicalBuilds = await tx
    .select({ id: builds.id, status: builds.status })
    .from(builds)
    .where(inArray(builds.projectId, projectIds))
    .orderBy(asc(builds.id))
    .limit(MAX_RECORDS + 1)
    .for("update", { noWait: true });
  const jobs = await tx
    .select({
      id: buildJobs.buildId,
      userId: buildJobs.userId,
      key: buildJobs.idempotencyKey,
      status: buildJobs.status,
    })
    .from(buildJobs)
    .where(inArray(buildJobs.projectId, projectIds))
    .orderBy(asc(buildJobs.buildId))
    .limit(MAX_RECORDS + 1)
    .for("update", { noWait: true });
  const published = await tx
    .select({
      id: deployments.id,
      userId: deployments.userId,
      key: deployments.idempotencyKey,
      status: deployments.status,
      mutationIntent: deployments.mutationIntent,
    })
    .from(deployments)
    .where(inArray(deployments.projectId, projectIds))
    .orderBy(asc(deployments.id))
    .limit(MAX_RECORDS + 1)
    .for("update", { noWait: true });
  const savedPreviews = await tx
    .select({
      id: previews.id,
      userId: previews.userId,
      status: previews.status,
      cleanup: previews.cleanupCompletedAt,
    })
    .from(previews)
    .where(inArray(previews.projectId, projectIds))
    .orderBy(asc(previews.id))
    .limit(MAX_RECORDS + 1)
    .for("update", { noWait: true });
  const previewIds = savedPreviews.map((row) => row.id);
  const requests = previewIds.length
    ? await tx
        .select()
        .from(previewRequests)
        .where(inArray(previewRequests.previewId, previewIds))
        .orderBy(asc(previewRequests.key))
        .limit(MAX_RECORDS + 1)
        .for("update", { noWait: true })
    : [];
  const turns = await tx
    .select({ id: conversationTurns.id, status: conversationTurns.status })
    .from(conversationTurns)
    .innerJoin(
      conversations,
      eq(conversationTurns.conversationId, conversations.id),
    )
    .where(inArray(conversations.projectId, projectIds))
    .orderBy(asc(conversationTurns.id))
    .limit(MAX_RECORDS + 1)
    .for("update", { noWait: true });
  if (
    [historicalBuilds, jobs, published, savedPreviews, requests, turns].some(
      (rows) => rows.length > MAX_RECORDS,
    )
  )
    throw new LegacyRecoveryError(
      409,
      "This selection has too much history for bounded recovery. Select fewer projects.",
    );
  const blockers: string[] = [];
  if (
    [...jobs, ...published, ...savedPreviews, ...requests].some(
      (row) => row.userId !== LEGACY_USER_ID,
    )
  )
    blockers.push(
      "Historical ownership is inconsistent; operator review is required.",
    );
  if (
    historicalBuilds.some((row) =>
      ["pending", "generating", "building"].includes(row.status),
    ) ||
    jobs.some((row) => ["queued", "running"].includes(row.status))
  )
    blockers.push("Finish or cancel queued and running builds.");
  if (
    turns.some((row) =>
      ["queued", "running", "waiting_build"].includes(row.status),
    )
  )
    blockers.push("Finish or cancel active conversations.");
  if (savedPreviews.some((row) => !row.cleanup))
    blockers.push("Stop previews and wait for verified container cleanup.");
  if (
    published.some(
      (row) =>
        [
          "queued",
          "preparing",
          "deploying",
          "verifying",
          "interrupted",
        ].includes(row.status) || row.mutationIntent,
    )
  )
    blockers.push(
      "Complete or reconcile deployments and unresolved remote operations.",
    );
  const jobKeys = jobs.map((row) => row.key),
    deploymentKeys = published.map((row) => row.key),
    requestKeys = requests.map((row) => row.key);
  const jobCollision = jobKeys.length
    ? await tx
        .select({ id: buildJobs.buildId })
        .from(buildJobs)
        .where(
          and(
            eq(buildJobs.userId, actorId),
            inArray(buildJobs.idempotencyKey, jobKeys),
          ),
        )
        .limit(1)
    : [];
  const deploymentCollision = deploymentKeys.length
    ? await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.userId, actorId),
            inArray(deployments.idempotencyKey, deploymentKeys),
          ),
        )
        .limit(1)
    : [];
  const requestCollision = requestKeys.length
    ? await tx
        .select({ key: previewRequests.key })
        .from(previewRequests)
        .where(
          and(
            eq(previewRequests.userId, actorId),
            inArray(previewRequests.key, requestKeys),
          ),
        )
        .limit(1)
    : [];
  if (
    jobCollision.length ||
    deploymentCollision.length ||
    requestCollision.length
  )
    blockers.push(
      "A request key conflicts with the destination account. Keys will not be rewritten.",
    );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        actorId,
        selected,
        historicalBuilds,
        jobs,
        published,
        savedPreviews,
        requests,
        turns,
      }),
    )
    .digest("hex");
  return {
    fingerprint,
    blockers,
    selected: selected.map(({ id, name }) => ({ id, name })),
    previewIds,
  };
}
/** Owner-only bounded inventory; ordinary project access is unchanged. */
export function listLegacyProjects(
  database: typeof db,
  actorId: string,
): Promise<{ projects: Array<{ id: string; name: string }>; more: boolean }> {
  return operation(() =>
    database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      const rows = await tx
        .select({ id: projects.id, name: projects.name })
        .from(projects)
        .where(eq(projects.userId, LEGACY_USER_ID))
        .orderBy(asc(projects.id))
        .limit(MAX_INVENTORY + 1);
      return {
        projects: rows.slice(0, MAX_INVENTORY),
        more: rows.length > MAX_INVENTORY,
      };
    }),
  );
}
/** Persists an expiring exact-selection review; blocked reviews cannot be confirmed. */
export function reviewLegacyProjects(
  database: typeof db,
  actorId: string,
  raw: unknown,
): Promise<{
  reviewId: string | null;
  projects: Array<{ id: string; name: string }>;
  blockers: string[];
}> {
  return operation(async () => {
    const input = Selection.safeParse(raw);
    if (
      !input.success ||
      new Set(input.data.projectIds).size !== input.data.projectIds.length
    )
      throw new LegacyRecoveryError(
        400,
        "Select between one and twenty distinct project IDs.",
      );
    return database.transaction(
      async (tx) => {
        await requireOwner(tx, actorId);
        await lockQueues(tx);
        const projectIds = [...input.data.projectIds].sort();
        const review = await inspect(tx, actorId, projectIds);
        if (review.blockers.length)
          return {
            reviewId: null,
            projects: review.selected,
            blockers: review.blockers,
          };
        const reviewId = crypto.randomUUID();
        await tx
          .insert(legacyProjectRecovery)
          .values({
            id: reviewId,
            actorId,
            sourceId: LEGACY_USER_ID,
            projectIds,
            fingerprint: review.fingerprint,
            expiresAt: new Date(Date.now() + REVIEW_TTL_MS),
          });
        return { reviewId, projects: review.selected, blockers: [] };
      },
      { accessMode: "read write", isolationLevel: "read committed" },
    );
  });
}
/** Transfers the reviewed selection atomically and preserves an immutable completion audit. */
export function confirmLegacyProjects(
  database: typeof db,
  actorId: string,
  raw: unknown,
): Promise<{ transferred: number; replayed: boolean }> {
  return operation(async () => {
    const input = Confirmation.safeParse(raw);
    if (!input.success)
      throw new LegacyRecoveryError(
        400,
        "Provide valid review and request identities.",
      );
    return database.transaction(async (tx) => {
      await requireOwner(tx, actorId);
      await lockQueues(tx);
      const [review] = await tx
        .select()
        .from(legacyProjectRecovery)
        .where(eq(legacyProjectRecovery.id, input.data.reviewId))
        .for("update", { noWait: true });
      if (
        !review ||
        review.actorId !== actorId ||
        review.sourceId !== LEGACY_USER_ID
      )
        throw new LegacyRecoveryError(
          409,
          "This review is unavailable. Review the selection again.",
        );
      if (review.completedAt) {
        if (review.requestId !== input.data.requestId)
          throw new LegacyRecoveryError(
            409,
            "This review was already confirmed with a different request.",
          );
        return { transferred: review.projectIds.length, replayed: true };
      }
      if (review.expiresAt.getTime() <= Date.now())
        throw new LegacyRecoveryError(
          409,
          "This review expired. Review the selection again.",
        );
      const current = await inspect(tx, actorId, review.projectIds);
      if (current.blockers.length)
        throw new LegacyRecoveryError(409, current.blockers.join(" "));
      if (current.fingerprint !== review.fingerprint)
        throw new LegacyRecoveryError(
          409,
          "Project history changed after review. Review the selection again.",
        );
      await tx
        .update(projects)
        .set({ userId: actorId })
        .where(inArray(projects.id, review.projectIds));
      await tx
        .update(buildJobs)
        .set({ userId: actorId })
        .where(inArray(buildJobs.projectId, review.projectIds));
      await tx
        .update(deployments)
        .set({ userId: actorId })
        .where(inArray(deployments.projectId, review.projectIds));
      await tx
        .update(previews)
        .set({ userId: actorId })
        .where(inArray(previews.projectId, review.projectIds));
      if (current.previewIds.length) {
        await tx
          .update(previewRequests)
          .set({ userId: actorId })
          .where(inArray(previewRequests.previewId, current.previewIds));
        await tx
          .delete(previewAccess)
          .where(inArray(previewAccess.previewId, current.previewIds));
      }
      await tx
        .update(legacyProjectRecovery)
        .set({ requestId: input.data.requestId, completedAt: new Date() })
        .where(eq(legacyProjectRecovery.id, review.id));
      return { transferred: review.projectIds.length, replayed: false };
    });
  });
}
/** Verify migration before listeners start; query timeouts are configured on the connection. */
export function verifyLegacyRecoverySchema(database: typeof db): Promise<void> {
  return operation(async () => {
    await database.select().from(legacyProjectRecovery).limit(0);
  });
}
