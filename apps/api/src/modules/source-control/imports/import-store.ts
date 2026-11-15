/**
 * COMPONENT: Reviewed private-project import
 * PURPOSE: Save reviewed source and queue one exact-source validation, atomically.
 * INPUTS: Current local principal, immutable server-fetched snapshot, review and request UUIDs.
 * OUTPUTS: Expiring review or an exactly replayable project/build acknowledgement.
 * STEPS: Bound source, recheck connection, save review; lock queue/account, consume review, create private project and validation job.
 * EDGE CASES: Lost replies replay the original project; expired reviews and changed connections require another review.
 * ERROR STATES: Never leave a partial project, execute source in the request or call a model.
 */
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNull,
  isNotNull,
  lte,
} from "drizzle-orm";
import { z } from "zod";
import {
  sourceConnections,
  sourceGitHubApp,
  sourceImportReviews,
  sourceProjectOrigins,
  projects,
  builds,
  buildJobs,
  buildQueue,
  buildEvents,
  type db,
} from "@wrenly/db";
import { validateSourceFiles, validateApplicationRoot } from "@wrenly/source-control";
import type { GitHubSourceSnapshot } from "@wrenly/source-control";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { requireProjectCapability } from "../../projects/access/project-access";
import {
  assertSourcePrincipal,
  SourceConnectionError,
} from "../github/authorization-store";
const REVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_REVIEWS = 4;
const MAX_QUEUED_BUILDS = 20;
const MAX_BUILD_SOURCE_BYTES = 2 * 1024 * 1024;
const ImportCommand = z
  .object({
    requestId: z.uuid(),
    reviewId: z.uuid(),
    name: z.string().trim().min(1).max(100),
  })
  .strict();
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function assertSourceImportConnection(
  tx: Transaction,
  principal: AccessPrincipal,
  version: string,
): Promise<void> {
  const [app] = await tx
    .select({ version: sourceGitHubApp.version })
    .from(sourceGitHubApp)
    .where(eq(sourceGitHubApp.id, 1))
    .for("share");
  if (!app)
    throw new SourceConnectionError(
      409,
      "Register the instance GitHub App first.",
    );
  const [connection] = await tx
    .select({ id: sourceConnections.id })
    .from(sourceConnections)
    .where(
      and(
        eq(sourceConnections.userId, principal.userId),
        eq(sourceConnections.provider, "github"),
        eq(sourceConnections.version, version),
        eq(sourceConnections.appVersion, app.version),
        isNull(sourceConnections.disconnectedAt),
        isNotNull(sourceConnections.credential),
        gt(sourceConnections.accessExpiresAt, new Date()),
      ),
    )
    .for("share");
  if (!connection)
    throw new SourceConnectionError(
      409,
      "Your GitHub connection changed. Connect again and review the source.",
    );
}
/** All source is already fetched as data; persistence must not perform network or Docker work. */
export async function saveSourceImportReview(
  database: typeof db,
  principal: AccessPrincipal,
  connectionVersion: string,
  snapshot: GitHubSourceSnapshot,
  stack: "nextjs" | "laravel",
): Promise<{
  reviewId: string;
  expiresAt: Date;
  fileCount: number;
  excludedPaths: string[];
}> {
  const files = validateSourceFiles(snapshot.files);
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_BUILD_SOURCE_BYTES)
    throw new SourceConnectionError(
      400,
      "This repository exceeds the current 2 MiB build source limit.",
    );
  return database.transaction(async (tx) => {
    await assertSourcePrincipal(tx, principal);
    await assertSourceImportConnection(tx, principal, connectionVersion);
    await tx
      .delete(sourceImportReviews)
      .where(
        and(
          eq(sourceImportReviews.userId, principal.userId),
          lte(sourceImportReviews.expiresAt, new Date()),
        ),
      );
    const [pending] = await tx
      .select({ total: count() })
      .from(sourceImportReviews)
      .where(eq(sourceImportReviews.userId, principal.userId));
    if ((pending?.total ?? 0) >= MAX_REVIEWS)
      throw new SourceConnectionError(
        409,
        "Finish an existing import review or wait for it to expire.",
      );
    const expiresAt = new Date(Date.now() + REVIEW_TTL_MS);
    const [review] = await tx
      .insert(sourceImportReviews)
      .values({
        userId: principal.userId,
        connectionVersion,
        repository: snapshot.repository,
        commitId: snapshot.commitId,
        treeId: snapshot.treeId,
        applicationRoot: validateApplicationRoot(snapshot.applicationRoot ?? ""),
        stack,
        files,
        excludedPaths: snapshot.excludedPaths,
        expiresAt,
      })
      .returning({ id: sourceImportReviews.id });
    if (!review) throw new Error("Import review was not saved.");
    return {
      reviewId: review.id,
      expiresAt,
      fileCount: files.length,
      excludedPaths: snapshot.excludedPaths,
    };
  });
}
/** Queue/account locks match normal build admission. Review replay never admits a second project. */
export async function admitSourceImport(
  database: typeof db,
  principal: AccessPrincipal,
  raw: unknown,
): Promise<{ projectId: string; buildId: string; replayed: boolean }> {
  const command = ImportCommand.safeParse(raw);
  if (!command.success)
    throw new SourceConnectionError(
      400,
      "Provide the reviewed import, a request UUID and a project name.",
    );
  const input = command.data,
    requestIdentity = JSON.stringify([input.reviewId, input.name]);
  return database.transaction(async (tx) => {
    await tx.insert(buildQueue).values({ id: 1 }).onConflictDoNothing();
    await tx
      .select()
      .from(buildQueue)
      .where(eq(buildQueue.id, 1))
      .for("update");
    await assertSourcePrincipal(tx, principal);
    const [existing] = await tx
      .select()
      .from(sourceProjectOrigins)
      .where(
        and(
          eq(sourceProjectOrigins.userId, principal.userId),
          eq(sourceProjectOrigins.requestId, input.requestId),
        ),
      );
    if (existing) {
      if (existing.requestIdentity !== requestIdentity)
        throw new SourceConnectionError(
          409,
          "This request ID already identifies another import.",
        );
      await requireProjectCapability(
        tx,
        existing.projectId,
        principal.userId,
        "read",
      );
      return {
        projectId: existing.projectId,
        buildId: existing.buildId,
        replayed: true,
      };
    }
    const [review] = await tx
      .select()
      .from(sourceImportReviews)
      .where(
        and(
          eq(sourceImportReviews.id, input.reviewId),
          eq(sourceImportReviews.userId, principal.userId),
          gt(sourceImportReviews.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!review || review.expiresAt.getTime() <= Date.now())
      throw new SourceConnectionError(
        409,
        "The import review expired or is unavailable. Review the repository again.",
      );
    await assertSourceImportConnection(tx, principal, review.connectionVersion);
    const [consumed] = await tx
      .select({ id: sourceProjectOrigins.projectId })
      .from(sourceProjectOrigins)
      .where(eq(sourceProjectOrigins.reviewId, review.id));
    if (consumed)
      throw new SourceConnectionError(
        409,
        "This review already created a project. Open that project instead.",
      );
    const [capacity] = await tx
      .select({ total: count() })
      .from(buildJobs)
      .where(inArray(buildJobs.status, ["queued", "running"]));
    if ((capacity?.total ?? 0) >= MAX_QUEUED_BUILDS)
      throw new SourceConnectionError(
        409,
        "The build queue is full. Try again when a build finishes.",
      );
    const projectId = crypto.randomUUID(),
      buildId = crypto.randomUUID();
    await tx.insert(projects).values({
      id: projectId,
      userId: principal.userId,
      name: input.name,
      stack: review.stack,
      accessMode: "private",
    });
    await tx.insert(builds).values({
      id: buildId,
      projectId,
      prompt: `Validate imported ${review.repository.owner}/${review.repository.name} at ${review.commitId}`,
      stack: review.stack,
      model: "none",
      provider: "source-import",
      status: "pending",
      files: review.files,
    });
    await tx.insert(buildJobs).values({
      buildId,
      projectId,
      userId: principal.userId,
      idempotencyKey: input.requestId,
      requestIdentity,
      input: {
        prompt: "Validate exact imported source",
        stack: review.stack,
        model: "none",
        provider: "source-import",
        previousFiles: review.files,
        previousErrors: [],
        sourceValidationV1: { version: 1, commitId: review.commitId },
      },
      nextEventSequence: 2,
    });
    await tx.insert(buildEvents).values({
      buildId,
      sequence: 1,
      type: "status",
      data: {
        buildId,
        phase: "queued",
        attempt: 0,
        message: "Imported source saved. Waiting for Docker validation.",
      },
    });
    await tx.insert(sourceProjectOrigins).values({
      projectId,
      userId: principal.userId,
      requestId: input.requestId,
      requestIdentity,
      reviewId: review.id,
      buildId,
      repository: review.repository,
      commitId: review.commitId,
      treeId: review.treeId,
      applicationRoot: review.applicationRoot,
      baseline: review.files,
    });
    return { projectId, buildId, replayed: false };
  });
}
