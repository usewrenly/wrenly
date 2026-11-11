/** Safe project-owner progress for one saved Production creation; never decrypts instance or role credentials. */
import { and, desc, eq } from "drizzle-orm";
import {
  projects,
  productionDatabaseConnections,
  productionDatabaseProvisions,
  productionDatabaseProvisionReviews as reviews,
  type db,
} from "@wrenly/db";
import { z } from "zod";
import { ProductionProjectCreationState } from "@wrenly/db/production-project-contract";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { lockDatabaseQueues } from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import { ProjectAccessError } from "../../../projects/access/project-access";
import { AccessDeniedError } from "../../../auth/access/access-policy";
import { requireProductionProjectOwner } from "./store";
/** Exact request lookup permits lost-response recovery without admitting another database creation. */
export async function readProjectProductionCreation(
  database: typeof db,
  principal: AccessPrincipal,
  projectId: string,
  requestId?: string,
): Promise<z.infer<typeof ProductionProjectCreationState>> {
  z.uuid().parse(projectId);
  if (requestId !== undefined) z.uuid().parse(requestId);
  try {
    return await accessContext.run({ principal }, () =>
      database.transaction(async (tx) => {
        await lockDatabaseQueues(tx);
        await requireProductionProjectOwner(tx, projectId, principal);
        const [project] = await tx
          .select({ revision: projects.accessRevision })
          .from(projects)
          .where(eq(projects.id, projectId));
        if (!project) throw new AppDatabaseError(404, "Project not found.");
        const [connection] = await tx
          .select({
            id: productionDatabaseConnections.id,
            status: productionDatabaseConnections.status,
            verified: productionDatabaseConnections.verified,
          })
          .from(productionDatabaseConnections)
          .orderBy(
            desc(productionDatabaseConnections.createdAt),
            desc(productionDatabaseConnections.id),
          )
          .limit(1);
        const [saved] = await tx
          .select({
            id: productionDatabaseProvisions.id,
            requestId: productionDatabaseProvisions.requestId,
            status: productionDatabaseProvisions.status,
            completedPhases: productionDatabaseProvisions.completedPhases,
            errorCode: productionDatabaseProvisions.errorCode,
          })
          .from(productionDatabaseProvisions)
          .where(
            and(
              eq(productionDatabaseProvisions.projectId, projectId),
              eq(productionDatabaseProvisions.actorId, principal.userId),
              eq(productionDatabaseProvisions.mode, "cluster"),
              ...(requestId
                ? [eq(productionDatabaseProvisions.requestId, requestId)]
                : []),
            ),
          )
          .orderBy(
            desc(productionDatabaseProvisions.createdAt),
            desc(productionDatabaseProvisions.id),
          )
          .limit(1);
        const review = saved
          ? ((
              await tx
                .select({
                  reviewId: reviews.id,
                  resourceId: reviews.provisionId,
                  requestId: reviews.requestId,
                  resumedRequestId: reviews.resumedRequestId,
                  phase: reviews.phase,
                  status: reviews.status,
                })
                .from(reviews)
                .where(
                  and(
                    eq(reviews.provisionId, saved.id),
                    eq(reviews.actorId, principal.userId),
                  ),
                )
                .orderBy(desc(reviews.createdAt), desc(reviews.id))
                .limit(1)
            )[0] ?? null)
          : null;
        return ProductionProjectCreationState.parse({
          projectId,
          review,
          projectRevision: project.revision,
          connectionId:
            connection?.status === "verified" && connection.verified
              ? connection.id
              : null,
          creation: saved
            ? {
                resourceId: saved.id,
                requestId: saved.requestId,
                status: saved.status,
                completedPhases: saved.completedPhases,
                errorCode: saved.errorCode,
              }
            : null,
        });
      }),
    );
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    if (error instanceof ProjectAccessError)
      throw new AppDatabaseError(
        error.status,
        "Project access could not be confirmed.",
      );
    if (error instanceof AccessDeniedError)
      throw new AppDatabaseError(
        403,
        "Your access has changed. Sign in again.",
      );
    throw new AppDatabaseError(
      503,
      "Production creation status could not be verified.",
    );
  }
}
