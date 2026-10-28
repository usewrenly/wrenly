/** Confirms runtime-role quiescence only after this preview's application and socket cleanup. */
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { appDatabases, previewDatabaseBindings, previewDatabaseRuntime, type db } from "@wrenly/db";
import { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";
import { AppDatabaseRuntimeIdentity, type AppDatabaseRuntimeIdentity as RuntimeIdentity } from "@wrenly/db/app-database-runtime-contract";
import { validateAppDatabaseCredentials, type AppDatabaseCredentials } from "@wrenly/db/app-database-roles";
import { terminateManagedDatabaseSessions } from "@wrenly/sandbox/database-administrator";
import { AppDatabaseError } from "../database-contract";
import { decryptDatabaseSecret, loadDatabaseKey } from "../database-secrets";
import { getDatabaseWorkerBundle } from "../database-worker-bundle";
import type { RuntimeKernelFence } from "./runtime-store";
import {
  assertPreviewDatabaseCleanup, recordPreviewDatabaseCleanup,
  acknowledgePreviewDatabaseCleanup, type PreviewDatabaseCleanupClaim,
} from "./cleanup-store";
import { previewRuntimeCleanupTarget } from "./runtime-policy";

async function loadCleanupConnection(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  directory: string,
  held: () => Promise<void>,
): Promise<{ resourceId: string; identity: RuntimeIdentity; credentials: AppDatabaseCredentials }> {
  let key: Buffer | undefined;
  try {
    await held();
    const [saved] = await database.select({
      binding: previewDatabaseBindings, resource: appDatabases,
      effect: previewDatabaseRuntime.cleanupEffect,
    }).from(previewDatabaseBindings)
      .innerJoin(appDatabases, eq(appDatabases.id, previewDatabaseBindings.resourceId))
      .innerJoin(previewDatabaseRuntime, eq(previewDatabaseRuntime.previewId, previewDatabaseBindings.previewId))
      .where(eq(previewDatabaseBindings.previewId, claim.preview.previewId));
    const revision = ValidatedDatabaseRevision.parse(saved?.binding.revision);
    if (!saved || saved.binding.resourceId !== revision.binding.resourceId ||
        saved.resource.projectId !== claim.preview.projectId ||
        revision.binding.projectId !== claim.preview.projectId ||
        revision.binding.buildId !== claim.preview.buildId ||
        saved.resource.revision !== revision.binding.resourceRevision ||
        saved.resource.environment !== "development" || saved.resource.provider !== "local" ||
        saved.effect?.kind !== "sessions" ||
        saved.effect.id !== previewRuntimeCleanupTarget(claim.preview, "sessions"))
      throw new Error("Original cleanup resource changed");
    const identity = AppDatabaseRuntimeIdentity.parse(saved.resource.runtimeIdentity);
    if (identity.volumeName !== `wrenly-database-${saved.resource.id}-data`)
      throw new Error("Original resource volume changed");
    key = await loadDatabaseKey(join(directory, "database-keys"), true);
    await held();
    const credentials = validateAppDatabaseCredentials(saved.resource.id, JSON.parse(
      decryptDatabaseSecret(saved.resource.secrets, key, `${saved.resource.id}:development`),
    ) as unknown);
    await held();
    return { resourceId: saved.resource.id, identity, credentials };
  } finally {
    key?.fill(0);
  }
}

/** Administrator credentials enter only the trusted stdin helper, never a generated app or return value. */
export async function cleanupPreviewDatabaseSessions(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  directory: string,
  signal: AbortSignal,
  assertKernel: RuntimeKernelFence,
  terminate: typeof terminateManagedDatabaseSessions = terminateManagedDatabaseSessions,
  bundle: () => Promise<Uint8Array> = () => getDatabaseWorkerBundle("administrator"),
): Promise<void> {
  try {
    const held = async (): Promise<void> => {
      signal.throwIfAborted();
      await assertPreviewDatabaseCleanup(database, claim, assertKernel);
      signal.throwIfAborted();
    };
    await held();
    await recordPreviewDatabaseCleanup(database, claim, "sessions", assertKernel);
    const connection = await loadCleanupConnection(database, claim, directory, held);
    const administratorBundle = await bundle();
    await held();
    const verifyEffect = async (effect: { kind: string; id: string }): Promise<void> => {
      await held();
      if (effect.kind !== "terminate-sessions" || effect.id !== previewRuntimeCleanupTarget(claim.preview, "sessions"))
        throw new Error("Unexpected session cleanup target");
    };
    await terminate({
      scope: { projectId: claim.preview.projectId, resourceId: connection.resourceId, environment: "development" },
      database: connection.identity, credentials: connection.credentials,
      operationId: claim.preview.previewId, target: "runtime", administratorBundle, signal,
      fence: { assertHeld: held, beforeEffect: verifyEffect, acknowledgeEffect: verifyEffect },
    });
    await held();
    await acknowledgePreviewDatabaseCleanup(database, claim, "sessions", assertKernel);
  } catch {
    throw new AppDatabaseError(409,
      "Preview database session cleanup is unconfirmed. Preserve its reservation and saved cleanup target.");
  }
}
