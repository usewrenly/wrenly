/** Verify the source tables before accepting requests; an upgrade must fail clearly rather than halfway through OAuth. */
import {
  sourceGitHubApp,
  sourceConnections,
  sourceAuthorizationRequests,
  sourceImportReviews,
  sourceProjectOrigins,
  sourcePushOperations,
  sourcePushReviews,
  type db,
} from "@wrenly/db";
export async function verifySourceControlSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select().from(sourceGitHubApp).limit(1);
    await database.select().from(sourceConnections).limit(1);
    await database.select().from(sourceAuthorizationRequests).limit(1);
    await database.select().from(sourceImportReviews).limit(1);
    await database.select().from(sourceProjectOrigins).limit(1);
    await database.select().from(sourcePushOperations).limit(1);
    await database.select().from(sourcePushReviews).limit(1);
  } catch {
    throw new Error(
      "GitHub connection persistence requires migrations through 0039. Run bun run db:migrate from packages/db before starting the API.",
    );
  }
}
