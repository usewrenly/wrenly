/** Read-only phase inspection is a separate saved owner action; resuming always requires another explicit confirmation. */
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";
import {
  productionDatabaseProvisionReviews as reviews,
  productionDatabaseProvisions as provisions,
  productionDatabaseConnections as connections,
  type db,
} from "@wrenly/db";
import {
  PRODUCTION_PROVISION_PHASES,
  ProductionProvisionPhase,
  validateProductionProjectCredentials,
} from "@wrenly/db/production-project-credentials";
import type { ProductionPhaseInspection } from "@wrenly/db/production-project-recovery";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { lockDatabaseQueues } from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import { loadDatabaseKey, decryptDatabaseSecret } from "../../database-secrets";
import { openProductionConnection } from "../instance/credentials";
import {
  requireProductionProjectOwner,
  productionProjectSecretPurpose,
  loadProductionProjectKey,
  type ProjectProvisionReceipt,
  type beginProjectProductionPhase,
} from "./store";
const LEASE_MS = 60_000;
// Keep owner confirmation close to the inspected server state; an old report is not execution authority.
const REVIEW_TTL_MS = 5 * 60_000;
const ReviewInput = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.uuid(),
    confirmInspect: z.literal(true),
  })
  .strict();
const ResumeInput = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.uuid(),
    confirmContinue: z.literal(true),
  })
  .strict();
type Connection = typeof db;
type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
type Review = typeof reviews.$inferSelect;
type Provision = typeof provisions.$inferSelect;
export interface ProductionProvisionReviewReceipt {
  reviewId: string;
  resourceId: string;
  phase: ProductionProvisionPhase;
  status: Review["status"];
  replayed: boolean;
}
export interface ProductionProvisionReviewClaim {
  id: string;
  resourceId: string;
  projectId: string;
  token: string;
  principal: AccessPrincipal;
}
const receipt = (
  row: Review,
  replayed: boolean,
): ProductionProvisionReviewReceipt => ({
  reviewId: row.id,
  resourceId: row.provisionId,
  phase: row.phase,
  status: row.status,
  replayed,
});
function evidence(row: Provision, review: Review): boolean {
  return (
    row.mode === "cluster" &&
    row.status === "needs_review" &&
    row.accessRevision === review.accessRevision &&
    JSON.stringify(row.completedPhases) ===
      JSON.stringify(review.priorCompletedPhases) &&
    (row.effectPhase ??
      PRODUCTION_PROVISION_PHASES[row.completedPhases.length]) ===
      review.phase &&
    (row.effectStartedAt?.getTime() ?? null) ===
      (review.effectStartedAt?.getTime() ?? null)
  );
}
/** Captures one exact uncertain phase; never clears the creation blocker or starts SQL. */
export async function admitProductionProvisionReview(
  database: Connection,
  actor: AccessPrincipal,
  projectId: string,
  resourceId: string,
  raw: unknown,
): Promise<ProductionProvisionReviewReceipt> {
  z.uuid().parse(projectId);
  z.uuid().parse(resourceId);
  const input = ReviewInput.parse(raw);
  return accessContext.run({ principal: actor }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProductionProjectOwner(
        tx,
        projectId,
        actor,
        input.expectedRevision,
      );
      const [original] = await tx
        .select()
        .from(provisions)
        .where(
          and(
            eq(provisions.id, resourceId),
            eq(provisions.projectId, projectId),
          ),
        )
        .for("update");
      if (
        !original ||
        original.mode !== "cluster" ||
        original.actorId !== actor.userId ||
        original.accessRevision !== input.expectedRevision
      )
        throw new AppDatabaseError(404, "Production creation not found.");
      const [replay] = await tx
        .select()
        .from(reviews)
        .where(
          and(
            eq(reviews.actorId, actor.userId),
            eq(reviews.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (
          replay.provisionId !== resourceId ||
          replay.accessRevision !== input.expectedRevision
        )
          throw new AppDatabaseError(
            409,
            "This review request represents another creation.",
          );
        return receipt(replay, true);
      }
      if (
        original.status === "creating" &&
        original.leaseExpiresAt &&
        original.leaseExpiresAt.getTime() <= Date.now()
      ) {
        await tx
          .update(provisions)
          .set({
            status: "needs_review",
            errorCode: "sql_creation_interrupted",
          })
          .where(eq(provisions.id, resourceId));
      } else if (original.status !== "needs_review")
        throw new AppDatabaseError(
          409,
          "Wait for active creation to finish before inspection.",
        );
      await tx
        .update(reviews)
        .set({
          status: "interrupted",
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(
          and(
            eq(reviews.provisionId, resourceId),
            eq(reviews.status, "checking"),
            lte(reviews.leaseExpiresAt, new Date()),
          ),
        );
      const [active] = await tx
        .select({ id: reviews.id })
        .from(reviews)
        .where(
          and(
            eq(reviews.provisionId, resourceId),
            inArray(reviews.status, ["queued", "checking"]),
          ),
        )
        .limit(1);
      if (active)
        throw new AppDatabaseError(409, "A saved inspection is still active.");
      const phase = ProductionProvisionPhase.parse(
        original.effectPhase ??
          PRODUCTION_PROVISION_PHASES[original.completedPhases.length],
      );
      const [saved] = await tx
        .insert(reviews)
        .values({
          id: crypto.randomUUID(),
          provisionId: resourceId,
          actorId: actor.userId,
          sessionId: actor.sessionId,
          accountRevision: actor.revision,
          accessRevision: input.expectedRevision,
          requestId: input.requestId,
          phase,
          priorCompletedPhases: original.completedPhases,
          effectStartedAt: original.effectStartedAt,
        })
        .returning();
      if (!saved)
        throw new AppDatabaseError(
          503,
          "Inspection receipt could not be confirmed.",
        );
      return receipt(saved, false);
    }),
  );
}
/** An expired inspector does not run again without a newly confirmed owner request. */
export async function claimProductionProvisionReview(
  database: Connection,
): Promise<ProductionProvisionReviewClaim | null> {
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await tx
      .update(reviews)
      .set({
        status: "interrupted",
        completedAt: new Date(),
        claimToken: null,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(reviews.status, "checking"),
          lte(reviews.leaseExpiresAt, new Date()),
        ),
      );
    const [saved] = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.status, "queued"))
      .orderBy(asc(reviews.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!saved) return null;
    const [original] = await tx
      .select()
      .from(provisions)
      .where(eq(provisions.id, saved.provisionId));
    const actor = {
      userId: saved.actorId,
      sessionId: saved.sessionId,
      revision: saved.accountRevision,
    };
    return accessContext.run({ principal: actor }, async () => {
      try {
        if (!original || !evidence(original, saved))
          throw new Error("Evidence changed");
        await requireProductionProjectOwner(
          tx,
          original.projectId,
          actor,
          saved.accessRevision,
        );
      } catch {
        await tx
          .update(reviews)
          .set({ status: "refused", completedAt: new Date() })
          .where(eq(reviews.id, saved.id));
        return null;
      }
      const token = crypto.randomUUID();
      await tx
        .update(reviews)
        .set({
          status: "checking",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        })
        .where(eq(reviews.id, saved.id));
      return {
        id: saved.id,
        resourceId: saved.provisionId,
        projectId: original!.projectId,
        token,
        principal: actor,
      };
    });
  });
}
async function claimed(
  tx: Transaction,
  claim: ProductionProvisionReviewClaim,
): Promise<{ review: Review; original: Provision }> {
  const [original] = await tx
    .select()
    .from(provisions)
    .where(eq(provisions.id, claim.resourceId));
  if (!original) throw new AppDatabaseError(409, "Saved creation unavailable.");
  const [snapshot] = await tx
    .select()
    .from(reviews)
    .where(eq(reviews.id, claim.id));
  if (!snapshot)
    throw new AppDatabaseError(409, "Saved inspection unavailable.");
  await requireProductionProjectOwner(
    tx,
    original.projectId,
    claim.principal,
    snapshot.accessRevision,
  );
  const [review] = await tx
    .select()
    .from(reviews)
    .where(eq(reviews.id, claim.id))
    .for("update");
  if (
    !review ||
    review.provisionId !== original.id ||
    review.actorId !== claim.principal.userId ||
    review.sessionId !== claim.principal.sessionId ||
    review.accountRevision !== claim.principal.revision ||
    review.status !== "checking" ||
    review.claimToken !== claim.token ||
    !review.leaseExpiresAt ||
    review.leaseExpiresAt.getTime() <= Date.now() ||
    !evidence(original, review)
  )
    throw new AppDatabaseError(409, "Inspection changed or expired.");
  return { review, original };
}
/** Loads credentials only after the original evidence and exact live inspection claim are rechecked. */
export async function loadProductionProvisionReview(
  database: Connection,
  claim: ProductionProvisionReviewClaim,
  directory: string,
): Promise<
  Awaited<ReturnType<typeof beginProjectProductionPhase>> & {
    phase: ProductionProvisionPhase;
  }
> {
  const projectKey = await loadProductionProjectKey(database, directory);
  const instanceKey = await loadDatabaseKey(
    join(directory, "production-instance-keys"),
    true,
  );
  return accessContext.run({ principal: claim.principal }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const { review, original } = await claimed(tx, claim);
      const [server] = await tx
        .select()
        .from(connections)
        .where(eq(connections.id, original.connectionId!));
      if (
        !server ||
        server.status !== "verified" ||
        !server.verified ||
        !server.pinnedAddresses?.length
      )
        throw new AppDatabaseError(409, "Saved server identity unavailable.");
      const credentials = validateProductionProjectCredentials(
        original.id,
        JSON.parse(
          decryptDatabaseSecret(
            original.secrets,
            projectKey,
            productionProjectSecretPurpose(original),
          ),
        ),
      );
      return {
        phase: review.phase,
        credentials,
        server: {
          target: server.target,
          addresses: server.pinnedAddresses,
          clusterId: server.verified.clusterId,
          ...openProductionConnection(server.secret, server, instanceKey),
        },
      };
    }),
  );
}
/** Inspection saves facts only; no project SQL or creation status is advanced here. */
export async function finishProductionProvisionReview(
  database: Connection,
  claim: ProductionProvisionReviewClaim,
  outcome: ProductionPhaseInspection | "interrupted",
): Promise<ProductionProvisionReviewReceipt> {
  z.enum(["confirmed", "absent", "review", "interrupted"]).parse(outcome);
  return accessContext.run({ principal: claim.principal }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const { review, original } = await claimed(tx, claim);
      const status =
        outcome === "interrupted"
          ? "interrupted"
          : outcome === "review" ||
              (outcome === "confirmed" && original.effectPhase === null)
            ? "refused"
            : outcome;
      const [saved] = await tx
        .update(reviews)
        .set({
          status,
          claimToken: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
        })
        .where(eq(reviews.id, review.id))
        .returning();
      if (!saved)
        throw new AppDatabaseError(
          503,
          "Inspection acknowledgement could not be confirmed.",
        );
      return receipt(saved, false);
    }),
  );
}
/** Consumes a verified review once, retaining old history and queueing only unacknowledged phases. */
export async function resumeProductionProvision(
  database: Connection,
  actor: AccessPrincipal,
  projectId: string,
  reviewId: string,
  raw: unknown,
): Promise<ProjectProvisionReceipt> {
  z.uuid().parse(projectId);
  z.uuid().parse(reviewId);
  const input = ResumeInput.parse(raw);
  return accessContext.run({ principal: actor }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProductionProjectOwner(
        tx,
        projectId,
        actor,
        input.expectedRevision,
      );
      const [review] = await tx
        .select()
        .from(reviews)
        .where(eq(reviews.id, reviewId))
        .for("update");
      if (
        !review ||
        review.actorId !== actor.userId ||
        review.accessRevision !== input.expectedRevision ||
        !["confirmed", "absent"].includes(review.status)
      )
        throw new AppDatabaseError(
          409,
          "A verified phase inspection is required before continuing.",
        );
      const [original] = await tx
        .select()
        .from(provisions)
        .where(eq(provisions.id, review.provisionId))
        .for("update");
      if (
        !original ||
        original.projectId !== projectId ||
        original.actorId !== actor.userId
      )
        throw new AppDatabaseError(404, "Production creation not found.");
      const [otherResume] = await tx
        .select({ id: reviews.id })
        .from(reviews)
        .where(
          and(
            eq(reviews.actorId, actor.userId),
            eq(reviews.resumedRequestId, input.requestId),
          ),
        )
        .limit(1);
      if (otherResume && otherResume.id !== review.id)
        throw new AppDatabaseError(
          409,
          "This continuation request already represents another inspection.",
        );
      if (review.resumedRequestId) {
        if (review.resumedRequestId !== input.requestId)
          throw new AppDatabaseError(
            409,
            "This inspection already represents another continuation.",
          );
        return {
          resourceId: original.id,
          status: original.status,
          completedPhases: original.completedPhases,
          replayed: true,
        };
      }
      const [latest] = await tx
        .select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.provisionId, original.id))
        .orderBy(desc(reviews.createdAt), desc(reviews.id))
        .limit(1);
      if (
        latest?.id !== review.id ||
        !review.completedAt ||
        review.completedAt.getTime() + REVIEW_TTL_MS <= Date.now()
      )
        throw new AppDatabaseError(
          409,
          "This inspection is stale. Inspect the current creation state again.",
        );
      if (!evidence(original, review))
        throw new AppDatabaseError(
          409,
          "Creation evidence changed. Inspect its saved state again.",
        );
      const phases =
        review.status === "confirmed"
          ? [...original.completedPhases, review.phase]
          : original.completedPhases;
      if (
        phases.some(
          (phase, index) => phase !== PRODUCTION_PROVISION_PHASES[index],
        )
      )
        throw new AppDatabaseError(409, "Invalid saved creation progress.");
      const terminal = phases.length === PRODUCTION_PROVISION_PHASES.length;
      await tx
        .update(reviews)
        .set({ resumedRequestId: input.requestId })
        .where(eq(reviews.id, review.id));
      const [saved] = await tx
        .update(provisions)
        .set({
          status: terminal ? "created" : "queued",
          completedPhases: phases,
          executionPrincipal: actor,
          effectPhase: null,
          effectStartedAt: null,
          claimToken: null,
          leaseExpiresAt: null,
          errorCode: null,
          acknowledgedAt: terminal ? new Date() : null,
        })
        .where(eq(provisions.id, original.id))
        .returning();
      if (!saved)
        throw new AppDatabaseError(
          503,
          "Continuation acknowledgement could not be confirmed.",
        );
      return {
        resourceId: saved.id,
        status: saved.status,
        completedPhases: saved.completedPhases,
        replayed: false,
      };
    }),
  );
}
