/** Account access changes wait for active work under the same queue locks as admissions. */
import { hasMemberDatabaseWork } from "../../databases/database-activity";
import { and, eq, inArray, isNotNull, isNull, or, count } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  conversationQueue,
  buildQueue,
  previewQueue,
  deploymentQueue,
  projects,
  builds,
  buildJobs,
  conversationTurns,
  conversations,
  previews,
  deployments,
} from "../../../../../../packages/db/src/schema";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const QUEUE_ID = 1;
/** Acquire queues before the account lock so delayed admissions cannot cross a credential change. */
export async function lockAccountWorkQueues(tx: Transaction): Promise<void> {
  for (const table of [
    conversationQueue,
    buildQueue,
    previewQueue,
    deploymentQueue,
  ]) {
    await tx.insert(table).values({ id: QUEUE_ID }).onConflictDoNothing();
    await tx
      .select()
      .from(table)
      .where(eq(table.id, QUEUE_ID))
      .for("update", { noWait: true });
  }
}
/** Access changes cannot hide active work or an uncertain external effect. */
export async function accountWorkBlockers(
  tx: Transaction,
  targetId: string,
): Promise<string[]> {
  const found: string[] = [];
  const [jobs] = await tx
    .select({ value: count() })
    .from(buildJobs)
    .where(
      and(
        eq(buildJobs.userId, targetId),
        inArray(buildJobs.status, ["queued", "running"]),
      ),
    );
  const [legacy] = await tx
    .select({ value: count() })
    .from(builds)
    .innerJoin(projects, eq(projects.id, builds.projectId))
    .where(
      and(
        eq(projects.userId, targetId),
        inArray(builds.status, ["pending", "generating", "building"]),
      ),
    );
  const [turns] = await tx
    .select({ value: count() })
    .from(conversationTurns)
    .innerJoin(
      conversations,
      eq(conversations.id, conversationTurns.conversationId),
    )
    .innerJoin(projects, eq(projects.id, conversations.projectId))
    .where(
      and(
        or(
          eq(projects.userId, targetId),
          eq(conversationTurns.actorId, targetId),
        ),
        inArray(conversationTurns.status, [
          "queued",
          "running",
          "waiting_build",
        ]),
      ),
    );
  const [preparing] = await tx
    .select({ value: count() })
    .from(previews)
    .where(
      and(
        eq(previews.userId, targetId),
        or(
          inArray(previews.status, ["queued", "preparing", "starting"]),
          and(
            eq(previews.status, "interrupted"),
            isNull(previews.cleanupCompletedAt),
          ),
        ),
      ),
    );
  const [publishing] = await tx
    .select({ value: count() })
    .from(deployments)
    .where(
      and(
        eq(deployments.userId, targetId),
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
    );
  if (jobs?.value || legacy?.value) found.push("Builds are queued or running.");
  if (turns?.value) found.push("Conversations are still active.");
  if (preparing?.value) found.push("Preview preparation is still active.");
  if (publishing?.value)
    found.push("Publishing needs completion or reconciliation.");
  if (await hasMemberDatabaseWork(tx, targetId))
    found.push("Database work needs completion or reconciliation.");
  return found;
}
