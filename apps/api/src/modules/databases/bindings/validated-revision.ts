/**
 * COMPONENT: Validated code/database handoff
 * PURPOSE: Refuse runtime eligibility when compatible migrations lack an exact successful app test.
 * INPUTS: Current actor, project and explicit saved build/Development database selection.
 * OUTPUTS: Non-secret revision and validation identities; never a socket or reservation.
 * STEPS: Check applied schema compatibility, read the latest successful saved validation,
 * compare all source bytes and schema/migration identities, then recheck current access.
 * EDGE CASES: A schema-compatible edit still needs its own application test; migration
 * application can advance the resource revision after the disposable test completed.
 * ERROR STATES: Missing or mismatched evidence refuses the handoff without starting work.
 */
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  appDatabaseOperations,
  appDatabaseValidations,
  builds,
  type db,
} from "@wrenly/db";
import { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";
import { AppDatabaseError } from "../database-contract";
import { readFrozenMigrationSource } from "../database-migration-review";
import { databaseValidationSourceDigest } from "../validation/source-identity";
import {
  readDatabaseRevisionBinding,
  assertDatabaseRevisionBinding,
} from "./revision-binding";

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";

/** Call under the runtime's ordered admission locks; this read alone grants no execution authority. */
export async function readValidatedDatabaseRevision(
  database: Database,
  projectId: string,
  actorId: string,
  selection: unknown,
): Promise<ValidatedDatabaseRevision> {
  try {
    const binding = await readDatabaseRevisionBinding(
      database,
      projectId,
      actorId,
      selection,
    );
    const [saved] = await database
      .select({
        validation: appDatabaseValidations,
        files: builds.files,
        operationDigest: appDatabaseOperations.migrationDigest,
      })
      .from(appDatabaseValidations)
      .innerJoin(
        appDatabaseOperations,
        eq(appDatabaseOperations.id, appDatabaseValidations.operationId),
      )
      .innerJoin(builds, eq(builds.id, appDatabaseValidations.buildId))
      .where(
        and(
          eq(appDatabaseValidations.buildId, binding.buildId),
          eq(appDatabaseOperations.buildId, binding.buildId),
          eq(builds.projectId, projectId),
          eq(builds.status, "success"),
          eq(appDatabaseOperations.projectId, projectId),
          eq(appDatabaseOperations.databaseId, binding.resourceId),
          eq(appDatabaseOperations.kind, "validate-application"),
          eq(appDatabaseOperations.status, "success"),
          isNotNull(appDatabaseOperations.completedAt),
        ),
      )
      .orderBy(
        desc(appDatabaseOperations.completedAt),
        desc(appDatabaseOperations.id),
      )
      .limit(1);
    if (
      !saved ||
      saved.validation.framework !== binding.framework ||
      saved.validation.migrationDigest !== binding.migrationDigest ||
      saved.operationDigest !== binding.migrationDigest ||
      saved.validation.schemaDigest !== binding.schemaDigest ||
      !saved.files ||
      databaseValidationSourceDigest(
        readFrozenMigrationSource(
          saved.files,
          binding.migrationDigest,
          binding.framework,
        ).files,
      ) !== saved.validation.sourceDigest ||
      databaseValidationSourceDigest(saved.validation.files) !==
        saved.validation.sourceDigest
    )
      throw new AppDatabaseError(
        409,
        "Validate this exact app revision against the reviewed database schema before opening it.",
      );
    await assertDatabaseRevisionBinding(database, actorId, binding);
    return ValidatedDatabaseRevision.parse({
      binding,
      validationOperationId: saved.validation.operationId,
      sourceDigest: saved.validation.sourceDigest,
    });
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "The saved application validation could not be verified.",
    );
  }
}
