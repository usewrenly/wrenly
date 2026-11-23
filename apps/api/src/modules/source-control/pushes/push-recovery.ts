/** Recovery observes an exact saved branch; it never replays a tree, commit or ref POST. */
import { eq } from "drizzle-orm";
import { z } from "zod";
import { sourcePushOperations, sourcePushReviews, type db } from "@wrenly/db";
import {
  createGitHubObjectClient,
  readGitHubRepository,
  type GitHubObjectClient,
} from "@wrenly/source-control";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { readSourcePersonalToken } from "../github/connection-store";
import { SourceConnectionError } from "../github/authorization-store";
import { lockSourceProject } from "./push-store";
import {
  readSourceBranch,
  sourceRepositoryPath,
  verifySourceCommit,
} from "./push-worker";
const Recovery = z
  .object({ operationId: z.uuid(), confirmRemoteSettled: z.literal(true) })
  .strict();
/** Confirmation is explicit because a timed-out request might still be settling at GitHub. */
export async function reconcileSourcePush(
  database: typeof db,
  principal: AccessPrincipal,
  raw: unknown,
  signal: AbortSignal,
  directory: string,
  suppliedClient?: GitHubObjectClient,
): Promise<{ status: "success" | "failed" }> {
  const parsed = Recovery.safeParse(raw);
  if (!parsed.success)
    throw new SourceConnectionError(
      400,
      "Confirm that GitHub has finished processing this push before checking its result.",
    );
  const [saved] = await database
    .select()
    .from(sourcePushOperations)
    .where(eq(sourcePushOperations.id, parsed.data.operationId));
  if (!saved || saved.userId !== principal.userId)
    throw new SourceConnectionError(403, "Source push not found.");
  // Authorize before fetching even private repository metadata.
  await database.transaction(async (tx) => {
    await lockSourceProject(tx, principal, saved.projectId);
  });
  const [review] = await database
    .select()
    .from(sourcePushReviews)
    .where(eq(sourcePushReviews.id, saved.reviewId));
  if (!review)
    throw new SourceConnectionError(
      409,
      "Saved push review could not be read.",
    );
  if (
    saved.status !== "needs_review" &&
    !(
      saved.status === "running" &&
      saved.leaseExpiresAt &&
      saved.leaseExpiresAt.getTime() <= Date.now()
    )
  )
    throw new SourceConnectionError(
      409,
      "Only an interrupted source push can be reconciled.",
    );
  const client =
    suppliedClient ??
    createGitHubObjectClient(
      (await readSourcePersonalToken(database, principal, directory)).token,
    );
  readGitHubRepository(
    await client.get(`/repositories/${review.repository.id}`, signal),
    review.repository,
  );
  // Metadata access alone does not prove contents access. Verify the saved base before treating a ref 404 as absence.
  const baseline = await client.get(
    `${sourceRepositoryPath(review.repository)}/git/commits/${review.baseCommit}`,
    signal,
  );
  if (
    !baseline ||
    typeof baseline !== "object" ||
    !("sha" in baseline) ||
    baseline.sha !== review.baseCommit ||
    !("tree" in baseline) ||
    !baseline.tree ||
    typeof baseline.tree !== "object" ||
    !("sha" in baseline.tree) ||
    baseline.tree.sha !== review.baseTree
  )
    throw new SourceConnectionError(
      409,
      "Repository contents access and the saved baseline could not be verified.",
    );
  const remote = await readSourceBranch(
    client,
    review.repository,
    review.branch,
    signal,
  );
  let status: "success" | "failed" = "failed";
  if (remote !== null && remote === saved.commitId && saved.treeId) {
    verifySourceCommit(
      await client.get(
        `${sourceRepositoryPath(review.repository)}/git/commits/${remote}`,
        signal,
      ),
      remote,
      saved.treeId,
      review.baseCommit,
    );
    status = "success";
  }
  return database.transaction(async (tx) => {
    await lockSourceProject(tx, principal, saved.projectId);
    const [current] = await tx
      .select()
      .from(sourcePushOperations)
      .where(eq(sourcePushOperations.id, saved.id))
      .for("update");
    if (
      !current ||
      current.status !== saved.status ||
      current.claimToken !== saved.claimToken ||
      current.phase !== saved.phase
    )
      throw new SourceConnectionError(
        409,
        "The source push changed. Reload before reconciling.",
      );
    await tx
      .update(sourcePushOperations)
      .set({
        status,
        phase: status === "success" ? "complete" : current.phase,
        claimToken: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        errorCode:
          status === "success"
            ? null
            : remote === null
              ? "confirmed_branch_absent"
              : "branch_conflict",
      })
      .where(eq(sourcePushOperations.id, saved.id));
    return { status };
  });
}
