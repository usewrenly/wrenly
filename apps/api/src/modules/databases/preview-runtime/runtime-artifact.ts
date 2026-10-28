/** Closes one preview's preparation/image ownership after application, socket and session cleanup. */
import type { db } from "@wrenly/db";
import { cleanupOwnedRuntimeArtifact } from "@wrenly/sandbox/runtime-artifact-cleanup";
import { AppDatabaseError } from "../database-contract";
import type { RuntimeKernelFence } from "./runtime-store";
import {
  assertPreviewDatabaseCleanup,
  recordPreviewDatabaseCleanup,
  acknowledgePreviewDatabaseCleanup,
  type PreviewDatabaseCleanupClaim,
} from "./cleanup-store";

/** A cleanup receipt confirms removal only; an unknown preparation result stays unknown. */
export async function cleanupPreviewDatabaseArtifact(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
  remove: typeof cleanupOwnedRuntimeArtifact = cleanupOwnedRuntimeArtifact,
): Promise<void> {
  try {
    const held = (): Promise<void> =>
      assertPreviewDatabaseCleanup(database, claim, assertKernel);
    await held();
    await recordPreviewDatabaseCleanup(database, claim, "artifact", assertKernel);
    await remove(claim.preview.previewId, held);
    await held();
    await acknowledgePreviewDatabaseCleanup(database, claim, "artifact", assertKernel);
  } catch {
    throw new AppDatabaseError(409,
      "Preview artifact cleanup is unconfirmed. Preserve its reservation and saved cleanup target.");
  }
}
