/** Verify the source tables before accepting requests; an upgrade must fail clearly rather than halfway through OAuth. */
import {
  sourceGitHubApp,
  sourceConnections,
  sourceAuthorizationRequests,
  type db,
} from "@wrenly/db";
export async function verifySourceControlSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database.select().from(sourceGitHubApp).limit(1);
    await database.select().from(sourceConnections).limit(1);
    await database.select().from(sourceAuthorizationRequests).limit(1);
  } catch {
    throw new Error(
      "GitHub connection persistence requires migrations through 0036. Run bun run db:migrate from packages/db before starting the API.",
    );
  }
}
