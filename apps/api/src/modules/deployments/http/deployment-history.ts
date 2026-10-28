/**
 * Deployment history query.
 * Called by the authenticated collection endpoint.
 * Selects explicit public columns under current project-read policy, including readable archived history; never contacts providers or returns execution snapshots.
 */

import { deployments, projects, type db } from "@wrenly/db";
import { desc, eq } from "drizzle-orm";
import { assertActiveAccount } from "../../auth/access/access-policy";
import { readableProjectPredicate } from "../../projects/access/project-access";
export const DEPLOYMENT_HISTORY_PAGE_SIZE = 24;
/** Filters even stored URLs before returning a browser navigation destination. */
export function publicDeploymentUrl(value: string | null): string | null {
  try {
    if (!value) return null;
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
/** Reads only currently accessible projects, including their archived history. */
export async function listDeploymentHistory(
  database: typeof db,
  actorId: string,
  offset: number,
): Promise<{
  deployments: Array<{
    id: string;
    projectId: string;
    projectName: string;
    buildId: string;
    stack: string;
    status: string;
    createdAt: Date;
    url: string | null;
  }>;
  nextOffset: number | null;
}> {
  return database.transaction(async (transaction) => {
    await assertActiveAccount(transaction, actorId);
    const rows = await transaction
      .select({
        id: deployments.id,
        projectId: projects.id,
        projectName: projects.name,
        buildId: deployments.buildId,
        stack: deployments.stack,
        status: deployments.status,
        createdAt: deployments.createdAt,
        url: deployments.url,
      })
      .from(deployments)
      .innerJoin(projects, eq(projects.id, deployments.projectId))
      .where(readableProjectPredicate(transaction, actorId))
      .orderBy(desc(deployments.createdAt), desc(deployments.id))
      .limit(DEPLOYMENT_HISTORY_PAGE_SIZE + 1)
      .offset(offset);
    return {
      deployments: rows
        .slice(0, DEPLOYMENT_HISTORY_PAGE_SIZE)
        .map((row) => ({ ...row, url: publicDeploymentUrl(row.url) })),
      nextOffset:
        rows.length > DEPLOYMENT_HISTORY_PAGE_SIZE &&
        offset + DEPLOYMENT_HISTORY_PAGE_SIZE <= 10000
          ? offset + DEPLOYMENT_HISTORY_PAGE_SIZE
          : null,
    };
  });
}
