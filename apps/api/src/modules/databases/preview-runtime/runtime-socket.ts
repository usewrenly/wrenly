/** Opens only a preview's saved runtime-role socket; uncertain startup remains journalled for cleanup. */
import { eq } from "drizzle-orm";
import { previewDatabaseBindings, type db } from "@wrenly/db";
import { ValidatedDatabaseRevision } from "@wrenly/db/app-database-binding-contract";
import {
  startDatabaseSocket,
  cleanupScopedDatabaseSocket,
} from "@wrenly/sandbox";
import type { DatabaseSocketIdentity } from "@wrenly/sandbox";
import {
  interruptPreview,
  type PreviewClaim,
} from "../../previews/persistence/preview-store";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { AppDatabaseError } from "../database-contract";
import {
  recordPreviewDatabaseEffect,
  acknowledgePreviewDatabaseEffect,
  type RuntimeKernelFence,
} from "./runtime-store";
import { loadPreviewDatabaseConnection } from "./runtime-connection";
import {
  assertPreviewDatabaseCleanup,
  recordPreviewDatabaseCleanup,
  acknowledgePreviewDatabaseCleanup,
  type PreviewDatabaseCleanupClaim,
} from "./cleanup-store";
import { previewRuntimeEffectTarget } from "./runtime-policy";

/** No credential enters the return value; the trusted socket implementation delivers its runtime role through stdin. */
export async function openPreviewDatabaseSocket(
  database: typeof db,
  claim: PreviewClaim,
  directory: string,
  signal: AbortSignal,
  assertKernel: RuntimeKernelFence,
  start: typeof startDatabaseSocket = startDatabaseSocket,
): Promise<DatabaseSocketIdentity> {
  const held = async (): Promise<void> => {
    signal.throwIfAborted();
    await assertKernel();
    await assertPreviewDatabaseBinding(database, claim);
    await assertKernel();
    signal.throwIfAborted();
  };
  try {
    await held();
    await recordPreviewDatabaseEffect(
      database,
      claim,
      "create-socket",
      assertKernel,
    );
    const connection = await loadPreviewDatabaseConnection(
      database,
      claim,
      directory,
      assertKernel,
    );
    const binding = await assertPreviewDatabaseBinding(database, claim);
    const socket = await start({
      scope: {
        projectId: claim.projectId,
        resourceId: binding.binding.resourceId,
        environment: "development",
      },
      database: connection.identity,
      socketId: claim.previewId,
      role: { kind: "runtime", ...connection.role },
      signal,
      fence: {
        assertHeld: held,
        beforeEffect: async (effect) => {
          await held();
          if (
            effect.kind !== "create-socket" ||
            effect.id !== previewRuntimeEffectTarget(claim, "create-socket")
          )
            throw new Error("Unexpected socket effect");
        },
        acknowledgeEffect: async (effect) => {
          await held();
          if (
            effect.kind !== "create-socket" ||
            effect.id !== previewRuntimeEffectTarget(claim, "create-socket")
          )
            throw new Error("Unexpected socket acknowledgement");
        },
      },
    });
    await held();
    await acknowledgePreviewDatabaseEffect(
      database,
      claim,
      "create-socket",
      socket,
      assertKernel,
    );
    return socket;
  } catch {
    // If the lease has already expired, the unchanged claim/effect still blocks until quiescent recovery.
    try {
      await assertKernel();
      await interruptPreview(database, claim);
    } catch {
      /* Preserve the original pending effect and reservation. */
    }
    throw new AppDatabaseError(
      409,
      "Preview database socket startup is unconfirmed. Review its saved effect before preparing again.",
    );
  }
}

/** Remove only the original preview socket after app quiescence; persistent database/session cleanup stays separate. */
export async function cleanupPreviewDatabaseSocket(
  database: typeof db,
  claim: PreviewDatabaseCleanupClaim,
  assertKernel: RuntimeKernelFence,
  remove: typeof cleanupScopedDatabaseSocket = cleanupScopedDatabaseSocket,
): Promise<void> {
  try {
    const held = (): Promise<void> =>
      assertPreviewDatabaseCleanup(database, claim, assertKernel);
    await held();
    const [row] = await database
      .select()
      .from(previewDatabaseBindings)
      .where(eq(previewDatabaseBindings.previewId, claim.preview.previewId));
    const saved = ValidatedDatabaseRevision.parse(row?.revision);
    if (
      !row ||
      row.resourceId !== saved.binding.resourceId ||
      saved.binding.projectId !== claim.preview.projectId ||
      saved.binding.buildId !== claim.preview.buildId
    )
      throw new Error("Cleanup resource changed");
    await recordPreviewDatabaseCleanup(database, claim, "socket", assertKernel);
    await remove(
      {
        projectId: claim.preview.projectId,
        resourceId: row.resourceId,
        environment: "development",
      },
      claim.preview.previewId,
      held,
    );
    await held();
    await acknowledgePreviewDatabaseCleanup(
      database,
      claim,
      "socket",
      assertKernel,
    );
  } catch {
    throw new AppDatabaseError(
      409,
      "Preview database socket cleanup is unconfirmed. Preserve its reservation and cleanup target.",
    );
  }
}
