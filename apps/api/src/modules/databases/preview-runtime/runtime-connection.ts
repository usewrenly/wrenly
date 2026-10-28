/** Delivers only the selected Development runtime role after current preview/source/schema checks. */
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { appDatabases, previewDatabaseRuntime, type db } from "@wrenly/db";
import {
  validateAppDatabaseCredentials,
  type AppDatabaseCredentials,
} from "@wrenly/db/app-database-roles";
import {
  AppDatabaseRuntimeIdentity,
  type AppDatabaseRuntimeIdentity as RuntimeIdentity,
} from "@wrenly/db/app-database-runtime-contract";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { decryptDatabaseSecret, loadDatabaseKey } from "../database-secrets";
import { AppDatabaseError } from "../database-contract";
import type { RuntimeKernelFence } from "./runtime-store";

export interface PreviewDatabaseConnection {
  identity: RuntimeIdentity;
  role: AppDatabaseCredentials["runtime"];
}

/** Server-only executor input, never an HTTP response. Docker inspection must still verify the saved runtime identity. */
export async function loadPreviewDatabaseConnection(
  database: typeof db,
  claim: PreviewClaim,
  directory: string,
  assertKernel: RuntimeKernelFence,
): Promise<PreviewDatabaseConnection> {
  let key: Buffer | undefined;
  try {
    await assertKernel();
    const binding = await assertPreviewDatabaseBinding(database, claim);
    const [runtime] = await database
      .select({
        imageId: previewDatabaseRuntime.imageId,
        effects: previewDatabaseRuntime.completedEffects,
        pending: previewDatabaseRuntime.effect,
        cleanup: previewDatabaseRuntime.cleanupDeadlineAt,
      })
      .from(previewDatabaseRuntime)
      .where(eq(previewDatabaseRuntime.previewId, claim.previewId))
      .limit(1);
    if (
      !runtime?.imageId ||
      runtime.cleanup ||
      runtime.pending?.kind === "prepare-artifact" ||
      !runtime.effects.some(
        (effect) =>
          effect.kind === "prepare-artifact" &&
          effect.id === `wrenly-artifact-${claim.previewId}`,
      )
    )
      throw new Error("Preparation has not completed without database access");
    const [resource] = await database
      .select({
        id: appDatabases.id,
        secrets: appDatabases.secrets,
        identity: appDatabases.runtimeIdentity,
      })
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.id, binding.binding.resourceId),
          eq(appDatabases.projectId, claim.projectId),
          eq(appDatabases.revision, binding.binding.resourceRevision),
          eq(appDatabases.status, "ready"),
          eq(appDatabases.environment, "development"),
          eq(appDatabases.provider, "local"),
        ),
      )
      .limit(1);
    if (!resource) throw new Error("Resource changed");
    const identity = AppDatabaseRuntimeIdentity.parse(resource.identity);
    if (identity.volumeName !== `wrenly-database-${resource.id}-data`)
      throw new Error("Resource volume changed");
    key = await loadDatabaseKey(join(directory, "database-keys"), true);
    await assertKernel();
    await assertPreviewDatabaseBinding(database, claim);
    const credentials = validateAppDatabaseCredentials(
      resource.id,
      JSON.parse(
        decryptDatabaseSecret(
          resource.secrets,
          key,
          `${resource.id}:development`,
        ),
      ) as unknown,
    );
    // Never return any other role, the key, envelope or resource's private control metadata.
    const role = {
      user: credentials.runtime.user,
      password: credentials.runtime.password,
    };
    await assertPreviewDatabaseBinding(database, claim);
    await assertKernel();
    return { identity, role };
  } catch {
    throw new AppDatabaseError(
      409,
      "The preview's private database connection could not be verified. No connection was opened.",
    );
  } finally {
    key?.fill(0);
  }
}
