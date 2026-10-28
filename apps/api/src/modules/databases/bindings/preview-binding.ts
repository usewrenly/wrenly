/** Saves and rechecks a preview's exact validated Development schema; no connection credentials are read here. */
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  appDatabases,
  buildJobs,
  previews,
  previewDatabaseBindings,
  type db,
} from "@wrenly/db";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";
import { readProjectCapabilities } from "../../projects/access/project-access";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { AppDatabaseError } from "../database-contract";
import { databaseValidationSourceDigest } from "../validation/source-identity";
import { readValidatedDatabaseRevision } from "./validated-revision";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Database = typeof db | Transaction;

/** Caller already holds ordered queue/account/project locks; a newer reviewed resource revision is explicit. */
export async function freezePreviewDatabaseBinding(
  transaction: Transaction,
  projectId: string,
  buildId: string,
  actorId: string,
  value: unknown,
): Promise<ValidatedDatabaseRevision> {
  try {
    const selection = BuildDatabaseSelection.parse(value);
    const [job] = await transaction
      .select({ input: buildJobs.input })
      .from(buildJobs)
      .where(
        and(
          eq(buildJobs.buildId, buildId),
          eq(buildJobs.projectId, projectId),
          eq(buildJobs.status, "success"),
        ),
      );
    const original = BuildDatabaseSelection.safeParse(job?.input.databaseV1);
    if (!original.success || original.data.resourceId !== selection.resourceId)
      throw new AppDatabaseError(
        409,
        "Preview must use the Development resource saved with this successful build.",
      );
    const [resource] = await transaction
      .select({ id: appDatabases.id })
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, selection.resourceId),
          eq(appDatabases.projectId, projectId),
          eq(appDatabases.revision, selection.resourceRevision),
          eq(appDatabases.status, "ready"),
          eq(appDatabases.environment, "development"),
          eq(appDatabases.provider, "local"),
        ),
      )
      .for("update");
    if (!resource)
      throw new AppDatabaseError(
        409,
        "Reload the current ready Development resource before preparing this preview.",
      );
    return await readValidatedDatabaseRevision(
      transaction,
      projectId,
      actorId,
      {
        buildId,
        resourceId: selection.resourceId,
        resourceRevision: selection.resourceRevision,
        environment: "development",
      },
    );
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      409,
      "The preview's saved database revision could not be verified.",
    );
  }
}

/** Runtime adapters must call before each effect; a saved reservation alone grants no socket access. */
export async function assertPreviewDatabaseBinding(
  database: Database,
  claim: PreviewClaim,
): Promise<ValidatedDatabaseRevision> {
  try {
    const [saved] = await database
      .select({
        preview: previews,
        evidence: previewDatabaseBindings.revision,
        resourceId: previewDatabaseBindings.resourceId,
      })
      .from(previews)
      .innerJoin(
        previewDatabaseBindings,
        eq(previewDatabaseBindings.previewId, previews.id),
      )
      .where(
        and(
          eq(previews.id, claim.previewId),
          eq(previews.projectId, claim.projectId),
          eq(previews.buildId, claim.buildId),
          eq(previews.claimToken, claim.token),
          isNull(previews.cleanupCompletedAt),
          gt(previews.leaseExpiresAt, new Date()),
          inArray(previews.status, ["preparing", "starting", "ready"]),
        ),
      )
      .limit(1);
    if (
      !saved ||
      (saved.preview.status === "ready" &&
        (!saved.preview.expiresAt ||
          saved.preview.expiresAt.getTime() <= Date.now()))
    )
      throw new AppDatabaseError(
        409,
        "The preview no longer owns database access.",
      );
    const expected = ValidatedDatabaseRevision.parse(saved.evidence);
    if (
      saved.resourceId !== expected.binding.resourceId ||
      expected.binding.projectId !== claim.projectId ||
      expected.binding.buildId !== claim.buildId ||
      (claim.stack && claim.stack !== expected.binding.framework) ||
      databaseValidationSourceDigest(saved.preview.files) !==
        expected.sourceDigest ||
      !(
        await readProjectCapabilities(
          database,
          claim.projectId,
          saved.preview.userId,
        )
      )?.contribute
    )
      throw new AppDatabaseError(
        409,
        "The preview's source or database authority changed.",
      );
    const current = await readValidatedDatabaseRevision(
      database,
      claim.projectId,
      saved.preview.userId,
      {
        buildId: claim.buildId,
        resourceId: expected.binding.resourceId,
        resourceRevision: expected.binding.resourceRevision,
        environment: "development",
      },
    );
    if (
      JSON.stringify(ValidatedDatabaseRevision.parse(current)) !==
      JSON.stringify(expected)
    )
      throw new AppDatabaseError(
        409,
        "The preview's validated database evidence changed. Prepare the reviewed revision again.",
      );
    return current;
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      409,
      "Preview database access could not be confirmed. Do not start another effect.",
    );
  }
}
