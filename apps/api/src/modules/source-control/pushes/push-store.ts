/**
 * COMPONENT: Reviewed source export persistence
 * PURPOSE: Freeze owner-approved changes and persist intent before remote Git mutations.
 * INPUTS: Active local owner/session, selected terminal revision, repository baseline and new branch.
 * OUTPUTS: Expiring review, queued push and independently durable phase receipts.
 * STEPS: Lock account/project, verify source/connection, freeze diff, enqueue once; workers own remote effects.
 * EDGE CASES: Lost acknowledgements replay the same operation; changed access or credentials stop new effects.
 * ERROR STATES: Unconfirmed remote work stays needs-review and is never automatically retried.
 */
import { and, asc, count, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  builds,
  buildQueue,
  projects,
  sourceImportReviews,
  sourceProjectOrigins,
  sourcePushReviews,
  sourcePushOperations,
  type db,
} from "@wrenly/db";
import {
  reviewSourceChanges,
  assertNewSourceBranch,
} from "@wrenly/source-control";
import { requireProjectCapability } from "../../projects/access/project-access";
import type { AccessPrincipal } from "../../auth/access/access-context";
import {
  assertSourcePrincipal,
  SourceConnectionError,
} from "../github/authorization-store";
import { assertSourceImportConnection } from "../imports/import-store";
const MAX_SOURCE_FILES = 256;
const MAX_REVIEW_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_REVIEWS = 8;
const MAX_QUEUED_PUSHES = 20;
const UUID = z.uuid();
const Files = z
  .array(z.object({ path: z.string(), content: z.string() }).strict())
  .min(1)
  .max(MAX_SOURCE_FILES);
const ReviewInput = z
  .object({
    projectId: UUID,
    buildId: UUID,
    expectedRevision: UUID,
    branch: z.string().max(120),
  })
  .strict();
const BindInput = z
  .object({
    projectId: UUID,
    buildId: UUID,
    expectedRevision: UUID,
    reviewId: UUID,
    requestId: UUID,
  })
  .strict();
const PushInput = z.object({ reviewId: UUID, requestId: UUID }).strict();
const REVIEW_TTL_MS = 10 * 60 * 1000;
export const SOURCE_PUSH_LEASE_MS = 2 * 60 * 1000;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PushOperation = typeof sourcePushOperations.$inferSelect;
export type PushReview = typeof sourcePushReviews.$inferSelect;
export interface SourcePushClaim {
  operation: PushOperation;
  review: PushReview;
  token: string;
  principal: AccessPrincipal;
}
/** Account → project ordering serializes every remote mutation with access revocation and archive. */
export async function lockSourceProject(
  tx: Transaction,
  principal: AccessPrincipal,
  projectId: string,
): Promise<typeof projects.$inferSelect> {
  await assertSourcePrincipal(tx, principal);
  await requireProjectCapability(tx, projectId, principal.userId, "manage");
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .for("update");
  if (!project || project.userId !== principal.userId || project.archivedAt)
    throw new SourceConnectionError(
      403,
      "Only the active project owner can manage its GitHub source.",
    );
  return project;
}
async function noPendingPush(
  tx: Transaction,
  projectId: string,
): Promise<void> {
  const [active] = await tx
    .select({ id: sourcePushOperations.id })
    .from(sourcePushOperations)
    .where(
      and(
        eq(sourcePushOperations.projectId, projectId),
        inArray(sourcePushOperations.status, [
          "queued",
          "running",
          "needs_review",
        ]),
      ),
    )
    .limit(1);
  if (active)
    throw new SourceConnectionError(
      409,
      "Finish or reconcile the existing source push first.",
    );
}
async function terminalSource(
  tx: Transaction,
  projectId: string,
  buildId: string,
) {
  const [build] = await tx
    .select()
    .from(builds)
    .where(and(eq(builds.projectId, projectId), eq(builds.id, buildId)));
  if (!build || !["success", "failed"].includes(build.status))
    throw new SourceConnectionError(
      409,
      "Select a finished revision before reviewing source changes.",
    );
  const files = Files.safeParse(build.files);
  if (!files.success)
    throw new SourceConnectionError(
      409,
      "This revision has no supported source snapshot.",
    );
  return { build, files: files.data };
}
/** Existing projects bind a reviewed remote baseline; this does not replace their local source. */
export async function bindSourceRepository(
  database: typeof db,
  principal: AccessPrincipal,
  raw: unknown,
): Promise<{ bound: true; replayed: boolean }> {
  const parsed = BindInput.safeParse(raw);
  if (!parsed.success)
    throw new SourceConnectionError(
      400,
      "Review the repository and current project before connecting source.",
    );
  const input = parsed.data,
    identity = JSON.stringify([
      input.projectId,
      input.buildId,
      input.expectedRevision,
      input.reviewId,
    ]);
  return database.transaction(async (tx) => {
    const project = await lockSourceProject(tx, principal, input.projectId);
    const [origin] = await tx
      .select()
      .from(sourceProjectOrigins)
      .where(eq(sourceProjectOrigins.projectId, project.id));
    if (origin) {
      if (
        origin.requestId === input.requestId &&
        origin.requestIdentity === identity
      )
        return { bound: true, replayed: true };
      throw new SourceConnectionError(
        409,
        "This project already has a repository baseline. Repository replacement is not supported yet.",
      );
    }
    if (project.accessRevision !== input.expectedRevision)
      throw new SourceConnectionError(
        409,
        "Project access changed. Reload before connecting source.",
      );
    await noPendingPush(tx, project.id);
    await terminalSource(tx, project.id, input.buildId);
    const [review] = await tx
      .select()
      .from(sourceImportReviews)
      .where(
        and(
          eq(sourceImportReviews.id, input.reviewId),
          eq(sourceImportReviews.userId, principal.userId),
        ),
      )
      .for("update");
    if (
      !review ||
      review.expiresAt.getTime() <= Date.now() ||
      review.stack !== project.stack
    )
      throw new SourceConnectionError(
        409,
        "The repository review expired or its framework does not match this project.",
      );
    await assertSourceImportConnection(tx, principal, review.connectionVersion);
    const [used] = await tx
      .select({ id: sourceProjectOrigins.projectId })
      .from(sourceProjectOrigins)
      .where(eq(sourceProjectOrigins.reviewId, review.id));
    if (used)
      throw new SourceConnectionError(
        409,
        "This repository review has already been used.",
      );
    await tx.insert(sourceProjectOrigins).values({
      projectId: project.id,
      userId: principal.userId,
      requestId: input.requestId,
      requestIdentity: identity,
      reviewId: review.id,
      buildId: input.buildId,
      repository: review.repository,
      commitId: review.commitId,
      treeId: review.treeId,
      baseline: review.files,
    });
    return { bound: true, replayed: false };
  });
}
export async function readSourceProject(
  database: typeof db,
  principal: AccessPrincipal,
  projectId: string,
): Promise<unknown> {
  if (!UUID.safeParse(projectId).success)
    throw new SourceConnectionError(400, "Choose a project.");
  return database.transaction(async (tx) => {
    const project = await lockSourceProject(tx, principal, projectId);
    const [origin] = await tx
      .select()
      .from(sourceProjectOrigins)
      .where(eq(sourceProjectOrigins.projectId, projectId));
    const operations = await tx
      .select({
        id: sourcePushOperations.id,
        status: sourcePushOperations.status,
        phase: sourcePushOperations.phase,
        commitId: sourcePushOperations.commitId,
        errorCode: sourcePushOperations.errorCode,
        branch: sourcePushReviews.branch,
        repository: sourcePushReviews.repository,
      })
      .from(sourcePushOperations)
      .innerJoin(
        sourcePushReviews,
        eq(sourcePushReviews.id, sourcePushOperations.reviewId),
      )
      .where(eq(sourcePushOperations.projectId, projectId))
      .orderBy(desc(sourcePushOperations.createdAt))
      .limit(10);
    return {
      project: {
        id: project.id,
        name: project.name,
        stack: project.stack,
        revision: project.accessRevision,
      },
      origin: origin
        ? { repository: origin.repository, commitId: origin.commitId }
        : null,
      operations,
    };
  });
}
/** The reviewed diff is frozen independently of subsequent local builds. No remote call occurs here. */
export async function createSourcePushReview(
  database: typeof db,
  principal: AccessPrincipal,
  connectionVersion: string,
  raw: unknown,
): Promise<unknown> {
  const parsed = ReviewInput.safeParse(raw);
  if (!parsed.success)
    throw new SourceConnectionError(
      400,
      "Choose the saved revision and a new source branch.",
    );
  const input = parsed.data;
  try {
    assertNewSourceBranch(input.branch);
  } catch {
    throw new SourceConnectionError(
      400,
      "Use a new branch under wrenly/, with letters, numbers, slashes, hyphens or underscores.",
    );
  }
  return database.transaction(async (tx) => {
    const project = await lockSourceProject(tx, principal, input.projectId);
    if (project.accessRevision !== input.expectedRevision)
      throw new SourceConnectionError(
        409,
        "Project access changed. Reload before reviewing a push.",
      );
    await noPendingPush(tx, project.id);
    await assertSourceImportConnection(tx, principal, connectionVersion);
    const [origin] = await tx
      .select()
      .from(sourceProjectOrigins)
      .where(eq(sourceProjectOrigins.projectId, project.id));
    if (!origin)
      throw new SourceConnectionError(
        409,
        "Connect a repository baseline first.",
      );
    const { files } = await terminalSource(tx, project.id, input.buildId);
    let changes;
    try {
      changes = reviewSourceChanges(origin.baseline, files);
    } catch {
      throw new SourceConnectionError(
        400,
        "Source review rejected private configuration, unsupported files or workflow modifications. Keep .github/workflows unchanged.",
      );
    }
    if (!changes.length)
      throw new SourceConnectionError(
        409,
        "This revision matches the repository baseline. There is nothing to push.",
      );
    if (Buffer.byteLength(JSON.stringify(changes)) > MAX_REVIEW_BYTES)
      throw new SourceConnectionError(
        400,
        "The source change set exceeds the current 2 MiB limit.",
      );
    const [pending] = await tx
      .select({ total: count() })
      .from(sourcePushReviews)
      .where(
        and(
          eq(sourcePushReviews.userId, principal.userId),
          gt(sourcePushReviews.expiresAt, new Date()),
        ),
      );
    if ((pending?.total ?? 0) >= MAX_PENDING_REVIEWS)
      throw new SourceConnectionError(
        409,
        "Wait for an earlier push review to expire before creating another.",
      );
    const [review] = await tx
      .insert(sourcePushReviews)
      .values({
        userId: principal.userId,
        projectId: project.id,
        buildId: input.buildId,
        accessRevision: project.accessRevision,
        connectionVersion,
        repository: origin.repository,
        baseCommit: origin.commitId,
        baseTree: origin.treeId,
        branch: input.branch,
        changes,
        expiresAt: new Date(Date.now() + REVIEW_TTL_MS),
      })
      .returning();
    if (!review) throw new Error("Push review was not saved.");
    const before = new Map(
      origin.baseline.map((file) => [file.path, file.content]),
    );
    return {
      reviewId: review.id,
      repository: review.repository,
      baseCommit: review.baseCommit,
      branch: review.branch,
      changes: changes.map((change) => ({
        ...change,
        previousContent: before.get(change.path) ?? null,
      })),
      expiresAt: review.expiresAt,
    };
  });
}
export async function admitSourcePush(
  database: typeof db,
  principal: AccessPrincipal,
  raw: unknown,
): Promise<{ operationId: string; replayed: boolean }> {
  const parsed = PushInput.safeParse(raw);
  if (!parsed.success)
    throw new SourceConnectionError(
      400,
      "Confirm the reviewed push with its request ID.",
    );
  const input = parsed.data;
  return database.transaction(async (tx) => {
    await tx.insert(buildQueue).values({ id: 1 }).onConflictDoNothing();
    await tx
      .select()
      .from(buildQueue)
      .where(eq(buildQueue.id, 1))
      .for("update");
    await assertSourcePrincipal(tx, principal);
    const [prior] = await tx
      .select()
      .from(sourcePushOperations)
      .where(
        and(
          eq(sourcePushOperations.userId, principal.userId),
          eq(sourcePushOperations.requestId, input.requestId),
        ),
      );
    if (prior) {
      if (prior.reviewId !== input.reviewId)
        throw new SourceConnectionError(
          409,
          "This request ID identifies another push.",
        );
      await lockSourceProject(tx, principal, prior.projectId);
      return { operationId: prior.id, replayed: true };
    }
    const [review] = await tx
      .select()
      .from(sourcePushReviews)
      .where(
        and(
          eq(sourcePushReviews.id, input.reviewId),
          eq(sourcePushReviews.userId, principal.userId),
        ),
      );
    if (!review || review.expiresAt.getTime() <= Date.now())
      throw new SourceConnectionError(
        409,
        "The source review expired. Review again before pushing.",
      );
    const project = await lockSourceProject(tx, principal, review.projectId);
    if (project.accessRevision !== review.accessRevision)
      throw new SourceConnectionError(
        409,
        "Project access changed. Review again before pushing.",
      );
    await assertSourceImportConnection(tx, principal, review.connectionVersion);
    await noPendingPush(tx, project.id);
    const [used] = await tx
      .select({ id: sourcePushOperations.id })
      .from(sourcePushOperations)
      .where(eq(sourcePushOperations.reviewId, review.id));
    if (used)
      throw new SourceConnectionError(
        409,
        "That review already has a saved push.",
      );
    const [capacity] = await tx
      .select({ total: count() })
      .from(sourcePushOperations)
      .where(inArray(sourcePushOperations.status, ["queued", "running"]));
    if ((capacity?.total ?? 0) >= MAX_QUEUED_PUSHES)
      throw new SourceConnectionError(409, "The source push queue is full.");
    const [operation] = await tx
      .insert(sourcePushOperations)
      .values({
        userId: principal.userId,
        sessionId: principal.sessionId,
        accountRevision: principal.revision,
        projectId: project.id,
        reviewId: review.id,
        requestId: input.requestId,
      })
      .returning();
    if (!operation) throw new Error("Push was not saved.");
    return { operationId: operation.id, replayed: false };
  });
}
/** Expired work becomes review-only, never queued again. Separate API processes claim different rows. */
export async function claimSourcePush(
  database: typeof db,
): Promise<SourcePushClaim | null> {
  return database.transaction(async (tx) => {
    await tx
      .update(sourcePushOperations)
      .set({ status: "needs_review", errorCode: "worker_interrupted" })
      .where(
        and(
          eq(sourcePushOperations.status, "running"),
          lte(sourcePushOperations.leaseExpiresAt, new Date()),
        ),
      );
    const [operation] = await tx
      .select()
      .from(sourcePushOperations)
      .where(eq(sourcePushOperations.status, "queued"))
      .orderBy(asc(sourcePushOperations.createdAt))
      .for("update", { skipLocked: true })
      .limit(1);
    if (!operation) return null;
    const [review] = await tx
      .select()
      .from(sourcePushReviews)
      .where(eq(sourcePushReviews.id, operation.reviewId));
    if (!review) throw new Error("Saved push review missing.");
    const token = crypto.randomUUID();
    await tx
      .update(sourcePushOperations)
      .set({
        status: "running",
        claimToken: token,
        leaseExpiresAt: new Date(Date.now() + SOURCE_PUSH_LEASE_MS),
      })
      .where(eq(sourcePushOperations.id, operation.id));
    return {
      operation,
      review,
      token,
      principal: {
        userId: operation.userId,
        sessionId: operation.sessionId,
        revision: operation.accountRevision,
      },
    };
  });
}
/** A short transaction commits intent before a separate locked transaction sends the remote mutation. */
export async function withSourcePushClaim<T>(
  database: typeof db,
  claim: SourcePushClaim,
  run: (tx: Transaction, operation: PushOperation) => Promise<T>,
): Promise<T> {
  return database.transaction(async (tx) => {
    const project = await lockSourceProject(
      tx,
      claim.principal,
      claim.operation.projectId,
    );
    await assertSourceImportConnection(
      tx,
      claim.principal,
      claim.review.connectionVersion,
    );
    const [operation] = await tx
      .select()
      .from(sourcePushOperations)
      .where(eq(sourcePushOperations.id, claim.operation.id))
      .for("update");
    if (
      !operation ||
      operation.claimToken !== claim.token ||
      operation.status !== "running" ||
      !operation.leaseExpiresAt ||
      operation.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new SourceConnectionError(
        409,
        "The source worker no longer owns this operation.",
      );
    if (project.accessRevision !== claim.review.accessRevision)
      throw new SourceConnectionError(
        409,
        "Project access changed during the push.",
      );
    return run(tx, operation);
  });
}
