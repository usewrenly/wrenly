/**
 * COMPONENT: Durable GitHub branch writer
 * PURPOSE: Execute saved source pushes independently of browser requests.
 * INPUTS: Queued owner-reviewed intent and the initiating session's current personal token.
 * OUTPUTS: Tree/commit/ref receipts, verified success or review-only uncertainty.
 * STEPS: Claim once, preflight identity/ref, commit each phase intent, send bounded POST, persist receipt.
 * EDGE CASES: Worker loss, revoked access, existing refs and lost provider replies never trigger automatic replay.
 * ERROR STATES: Any possible remote effect keeps needs-review until explicit read-only reconciliation.
 */
import { eq, and } from "drizzle-orm";
import { sourcePushOperations, type db } from "@wrenly/db";
import {
  createGitHubObjectClient,
  readGitHubRepository,
  readGitHubSourceTree,
  assertNewSourceBranch,
  GitHubRequestError,
  type GitHubObjectClient,
  type SourceRepository,
} from "@wrenly/source-control";
import { readSourcePersonalToken } from "../github/connection-store";
import {
  claimSourcePush,
  withSourcePushClaim,
  SOURCE_PUSH_LEASE_MS,
  type SourcePushClaim,
} from "./push-store";
import { logger } from "../../../lib/logger";
const SHA = /^[a-f0-9]{40}$/;
const POLL_INTERVAL_MS = 1000;
function record(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw);
}
export function sourceRepositoryPath(repository: SourceRepository): string {
  if (
    !/^[A-Za-z0-9_.-]+$/.test(repository.owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository.name)
  )
    throw new Error("Invalid saved repository identity.");
  return `/repos/${repository.owner}/${repository.name}`;
}
/** A 404 is absence; authentication, rate limits and unreadable replies never count as absence. */
export async function readSourceBranch(
  client: GitHubObjectClient,
  repository: SourceRepository,
  branch: string,
  signal: AbortSignal,
): Promise<string | null> {
  assertNewSourceBranch(branch);
  try {
    const raw = await client.get(
      `${sourceRepositoryPath(repository)}/git/ref/heads/${branch}`,
      signal,
    );
    if (
      !record(raw) ||
      raw.ref !== `refs/heads/${branch}` ||
      !record(raw.object) ||
      raw.object.type !== "commit" ||
      typeof raw.object.sha !== "string" ||
      !SHA.test(raw.object.sha)
    )
      throw new Error("Remote branch could not be verified.");
    return raw.object.sha;
  } catch (error) {
    if (
      error instanceof GitHubRequestError &&
      error.code === "http_error" &&
      error.status === 404
    )
      return null;
    throw error;
  }
}
function objectId(raw: unknown): string {
  if (!record(raw) || typeof raw.sha !== "string" || !SHA.test(raw.sha))
    throw new Error("Remote Git object could not be verified.");
  return raw.sha;
}
/** Verify the published commit's immutable parent and tree, rather than trusting a branch name alone. */
export function verifySourceCommit(
  raw: unknown,
  commitId: string,
  treeId: string,
  parentId: string,
): void {
  if (
    !record(raw) ||
    raw.sha !== commitId ||
    !record(raw.tree) ||
    raw.tree.sha !== treeId ||
    !Array.isArray(raw.parents) ||
    raw.parents.length !== 1 ||
    !record(raw.parents[0]) ||
    raw.parents[0].sha !== parentId
  )
    throw new Error("Remote commit does not match the reviewed source.");
}
/** No injected callback can select a different destination, base tree, branch or commit. */
export async function executeSourcePush(
  database: typeof db,
  claim: SourcePushClaim,
  client: GitHubObjectClient,
  externalSignal: AbortSignal,
): Promise<void> {
  const signal = AbortSignal.any([
    externalSignal,
    AbortSignal.timeout(SOURCE_PUSH_LEASE_MS),
  ]);
  const review = claim.review,
    root = sourceRepositoryPath(review.repository);
  try {
    readGitHubRepository(
      await client.get(`/repositories/${review.repository.id}`, signal),
      review.repository,
    );
    if (
      (await readSourceBranch(
        client,
        review.repository,
        review.branch,
        signal,
      )) !== null
    )
      throw new Error("The requested branch already exists.");
    const base = await client.get(
      `${root}/git/commits/${review.baseCommit}`,
      signal,
    );
    if (
      !record(base) ||
      base.sha !== review.baseCommit ||
      !record(base.tree) ||
      base.tree.sha !== review.baseTree
    )
      throw new Error("Repository baseline could not be verified.");
    const { entries } = readGitHubSourceTree(
      await client.get(
        `${root}/git/trees/${review.baseTree}?recursive=1`,
        signal,
      ),
      review.baseTree,
    );
    const modes = new Map(
      entries.map((entry) => [
        entry.path,
        entry.executable ? "100755" : "100644",
      ]),
    );
    const tree = review.changes.map((change) => {
      if (change.kind === "delete") {
        if (!modes.has(change.path))
          throw new Error("A reviewed deletion is absent from the baseline.");
        return {
          path: change.path,
          mode: modes.get(change.path)!,
          type: "blob",
          sha: null,
        };
      }
      return {
        path: change.path,
        mode: modes.get(change.path) ?? "100644",
        type: "blob",
        content: change.content,
      };
    });
    async function phase(
      expected: "preflight" | "tree" | "commit",
      next: "tree" | "commit" | "ref",
    ): Promise<void> {
      await withSourcePushClaim(database, claim, async (tx, operation) => {
        signal.throwIfAborted();
        if (operation.phase !== expected)
          throw new Error("Saved push phase changed.");
        await tx
          .update(sourcePushOperations)
          .set({ phase: next })
          .where(eq(sourcePushOperations.id, operation.id));
      });
    }
    // A repository may be renamed or transferred during a review. Recheck its pinned
    // identity immediately before each write instead of following redirects.
    async function verifyDestination(): Promise<void> {
      readGitHubRepository(
        await client.get(`/repositories/${review.repository.id}`, signal),
        review.repository,
      );
    }
    await phase("preflight", "tree");
    await withSourcePushClaim(database, claim, async (tx, operation) => {
      if (operation.phase !== "tree" || operation.treeId !== null)
        throw new Error("Tree creation cannot be repeated.");
      await verifyDestination();
      const treeId = objectId(
        await client.post(
          `${root}/git/trees`,
          { base_tree: review.baseTree, tree },
          signal,
        ),
      );
      await tx
        .update(sourcePushOperations)
        .set({ treeId })
        .where(eq(sourcePushOperations.id, operation.id));
    });
    await phase("tree", "commit");
    await withSourcePushClaim(database, claim, async (tx, operation) => {
      if (
        operation.phase !== "commit" ||
        !operation.treeId ||
        operation.commitId !== null
      )
        throw new Error("Commit creation cannot be repeated.");
      await verifyDestination();
      const raw = await client.post(
        `${root}/git/commits`,
        {
          message: `Update app from Wrenly revision ${review.buildId}`,
          tree: operation.treeId,
          parents: [review.baseCommit],
        },
        signal,
      );
      const commitId = objectId(raw);
      verifySourceCommit(raw, commitId, operation.treeId, review.baseCommit);
      await tx
        .update(sourcePushOperations)
        .set({ commitId })
        .where(eq(sourcePushOperations.id, operation.id));
    });
    await phase("commit", "ref");
    await withSourcePushClaim(database, claim, async (tx, operation) => {
      if (operation.phase !== "ref" || !operation.commitId || !operation.treeId)
        throw new Error("Branch creation cannot be verified.");
      await verifyDestination();
      const raw = await client.post(
        `${root}/git/refs`,
        { ref: `refs/heads/${review.branch}`, sha: operation.commitId },
        signal,
      );
      if (
        !record(raw) ||
        raw.ref !== `refs/heads/${review.branch}` ||
        !record(raw.object) ||
        raw.object.sha !== operation.commitId
      )
        throw new Error("Branch creation could not be verified.");
      if (
        (await readSourceBranch(
          client,
          review.repository,
          review.branch,
          signal,
        )) !== operation.commitId
      )
        throw new Error("Created branch does not match the saved commit.");
      verifySourceCommit(
        await client.get(`${root}/git/commits/${operation.commitId}`, signal),
        operation.commitId,
        operation.treeId,
        review.baseCommit,
      );
      await tx
        .update(sourcePushOperations)
        .set({
          status: "success",
          phase: "complete",
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
          errorCode: null,
        })
        .where(eq(sourcePushOperations.id, operation.id));
    });
  } catch (error) {
    // Even an authorization failure cannot authorize repeating an earlier uncertain POST.
    await database
      .update(sourcePushOperations)
      .set({ status: "needs_review", errorCode: "remote_result_unconfirmed" })
      .where(
        and(
          eq(sourcePushOperations.id, claim.operation.id),
          eq(sourcePushOperations.claimToken, claim.token),
          eq(sourcePushOperations.status, "running"),
        ),
      );
    logger.error("Source push stopped before confirmation", {
      operationId: claim.operation.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
/** Starts one bounded worker loop. Expired running work is only marked for review, never replayed. */
export function startSourcePushWorker(
  database: typeof db,
  directory: string,
): { done: Promise<void>; stop(): Promise<void> } {
  const shutdown = new AbortController();
  const done = (async () => {
    while (!shutdown.signal.aborted) {
      try {
        const claim = await claimSourcePush(database);
        if (claim) {
          try {
            const personal = await readSourcePersonalToken(
              database,
              claim.principal,
              directory,
            );
            if (personal.version !== claim.review.connectionVersion)
              throw new Error("Source connection changed.");
            await executeSourcePush(
              database,
              claim,
              createGitHubObjectClient(personal.token),
              shutdown.signal,
            );
          } catch (error) {
            await database
              .update(sourcePushOperations)
              .set({
                status: "needs_review",
                errorCode: "source_authorization_changed",
              })
              .where(
                and(
                  eq(sourcePushOperations.id, claim.operation.id),
                  eq(sourcePushOperations.claimToken, claim.token),
                  eq(sourcePushOperations.status, "running"),
                ),
              );
            logger.error("Source push authorization unavailable", {
              operationId: claim.operation.id,
              errorName: error instanceof Error ? error.name : "UnknownError",
            });
          }
          continue;
        }
      } catch (error) {
        logger.error("Source push queue unavailable", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      }
      if (!shutdown.signal.aborted)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(finish, POLL_INTERVAL_MS);
          function finish(): void {
            clearTimeout(timer);
            shutdown.signal.removeEventListener("abort", finish);
            resolve();
          }
          shutdown.signal.addEventListener("abort", finish, { once: true });
        });
    }
  })();
  return {
    done,
    stop: async () => {
      shutdown.abort(new Error("Source worker stopped."));
      await done;
    },
  };
}
