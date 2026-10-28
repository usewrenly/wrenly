/**
 * COMPONENT: Frozen build database selection
 * PURPOSE: Remember an explicit Development choice before a build queues, without provisioning anything.
 * INPUTS: Admission transaction after queue/account/project locks, current actor and selected resource/revision.
 * OUTPUTS: Strict non-secret selection, or a refusal before the build is saved.
 * STEPS: Parse the choice, require current contribution access and a supported framework,
 * lock the exact local ready Development resource, compare its revision and reject unresolved work.
 * EDGE CASES: Absence stays stateless; retries reuse their saved choice and must still match current state.
 * ERROR STATES: No fallback resource, environment, actor or auto-provisioning on mismatch.
 */
import { and, eq } from "drizzle-orm";
import { appDatabases, type db } from "@wrenly/db";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { requireProjectCapability } from "../../projects/access/project-access";
import { hasDatabaseWork } from "../database-activity";
import { AppDatabaseError } from "../database-contract";
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Call inside ordered build admission, never from model output or a browser-selected connection string. */
export async function freezeBuildDatabaseSelection(
  transaction: Transaction,
  projectId: string,
  actorId: string,
  framework: string,
  value: unknown,
): Promise<BuildDatabaseSelection | undefined> {
  if (value === undefined) return undefined;
  try {
    const input = BuildDatabaseSelection.safeParse(value);
    if (!input.success || !["nextjs", "laravel"].includes(framework))
      throw new AppDatabaseError(
        409,
        "Choose a supported Development database before building this app.",
      );
    await requireProjectCapability(
      transaction,
      projectId,
      actorId,
      "contribute",
    );
    const [resource] = await transaction
      .select({ revision: appDatabases.revision })
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, input.data.resourceId),
          eq(appDatabases.projectId, projectId),
          eq(appDatabases.environment, "development"),
          eq(appDatabases.provider, "local"),
          eq(appDatabases.status, "ready"),
        ),
      )
      .for("update");
    if (
      !resource ||
      resource.revision !== input.data.resourceRevision ||
      (await hasDatabaseWork(transaction, projectId))
    )
      throw new AppDatabaseError(
        409,
        "Reload the ready Development database and resolve its work before building.",
      );
    return input.data;
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      409,
      "The build's Development database choice could not be confirmed.",
    );
  }
}
