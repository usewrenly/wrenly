/** Stops the original app/ingress under independent cleanup authority, without releasing its other reservations. */
import type { db } from "@wrenly/db";
import { cleanupPreviewRuntime } from "@wrenly/sandbox";
import { AppDatabaseError } from "../database-contract";
import type { RuntimeKernelFence } from "./runtime-store";
import {
  assertPreviewDatabaseCleanup,
  recordPreviewDatabaseCleanup,
  acknowledgePreviewDatabaseCleanup,
  type PreviewDatabaseCleanupClaim,
} from "./cleanup-store";

/** No successful receipt is saved after a lost cleanup lease or uncertain Docker removal. */
export async function cleanupPreviewDatabaseApplication(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
  remove: typeof cleanupPreviewRuntime = cleanupPreviewRuntime,
): Promise<void> {
  try {
    const held = (): Promise<void> =>
      assertPreviewDatabaseCleanup(database, claim, assertKernel);
    await held();
    await recordPreviewDatabaseCleanup(database, claim, "application", assertKernel);
    await remove({
      previewId: claim.preview.previewId,
      projectId: claim.preview.projectId,
      buildId: claim.preview.buildId,
      claimToken: claim.preview.token,
    }, held);
    await held();
    await acknowledgePreviewDatabaseCleanup(database, claim, "application", assertKernel);
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview application cleanup is unconfirmed. Preserve its reservation and saved cleanup target.",
    );
  }
}
