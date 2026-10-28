/** Prepares exact saved preview source offline, before any database credentials are loaded. */
import { eq } from "drizzle-orm";
import { previews, type db } from "@wrenly/db";
import { prepareDatabaseValidationArtifact } from "@wrenly/sandbox/runtime-artifact";
import { interruptPreview, type PreviewClaim } from "../../previews/persistence/preview-store";
import { AppDatabaseError } from "../database-contract";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { databaseValidationSourceDigest } from "../validation/source-identity";
import {
  recordPreviewDatabaseEffect,
  acknowledgePreviewDatabaseEffect,
  type RuntimeKernelFence,
} from "./runtime-store";

/** Caller owns lease renewal; an uncertain effect remains blocked for explicit cleanup, never automatic retry. */
export async function preparePreviewDatabaseArtifact(
  database: typeof db,
  claim: PreviewClaim,
  signal: AbortSignal,
  assertKernel: RuntimeKernelFence,
  prepare: typeof prepareDatabaseValidationArtifact = prepareDatabaseValidationArtifact,
): Promise<{ imageId: string }> {
  const held = async (): Promise<void> => {
    signal.throwIfAborted();
    await assertKernel();
    await assertPreviewDatabaseBinding(database, claim);
    await assertKernel();
    signal.throwIfAborted();
  };
  let attempted = false;
  try {
    await held();
    const evidence = await assertPreviewDatabaseBinding(database, claim);
    const [saved] = await database.select({ files: previews.files }).from(previews)
      .where(eq(previews.id, claim.previewId));
    if (!saved || databaseValidationSourceDigest(saved.files) !== evidence.sourceDigest)
      throw new Error("Saved preview source changed");
    await recordPreviewDatabaseEffect(database, claim, "prepare-artifact", assertKernel);
    attempted = true;
    await held();
    const image = await prepare({
      deploymentId: claim.previewId,
      stack: evidence.binding.framework,
      files: saved.files,
      migrationDigest: evidence.binding.migrationDigest,
      signal,
      beforeEffect: held,
    });
    await held();
    await acknowledgePreviewDatabaseEffect(database, claim, "prepare-artifact",
      { imageId: image.imageId }, assertKernel);
    return { imageId: image.imageId };
  } catch {
    if (attempted) {
      try {
        await assertKernel();
        await interruptPreview(database, claim);
      } catch {
        // The original intent still excludes another executor if interruption cannot be saved.
      }
    }
    throw new AppDatabaseError(409,
      "Preview image preparation is unconfirmed. Review its saved operation before preparing again.");
  }
}
