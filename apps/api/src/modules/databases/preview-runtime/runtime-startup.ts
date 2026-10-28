/** Connects the saved image/socket and runtime-only settings to persistent app/ingress startup. */
import { eq } from "drizzle-orm";
import { previewDatabaseRuntime, type db } from "@wrenly/db";
import { AppDatabaseSocketIdentity } from "@wrenly/db/app-database-runtime-contract";
import { startPreparedDatabasePreview } from "@wrenly/sandbox/database-preview-runtime";
import type { PreviewRuntimeInput, PreviewRuntimeResult } from "@wrenly/sandbox";
import { interruptPreview, updatePreviewProgress, type PreviewClaim } from "../../previews/persistence/preview-store";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { AppDatabaseError } from "../database-contract";
import { getDatabaseWorkerBundle } from "../database-worker-bundle";
import { loadPreviewDatabaseApplicationSettings } from "./runtime-settings";
import { recordPreviewDatabaseEffect, acknowledgePreviewDatabaseEffect, type RuntimeKernelFence } from "./runtime-store";

/** No browser input or live source is accepted; repeated/unknown startup stays blocked for explicit cleanup. */
export async function startPreviewDatabaseApplication(
  database: typeof db,
  claim: PreviewClaim,
  configuration: { directory: string; ingressBundle: Uint8Array; ingress: PreviewRuntimeInput["ingress"]; lifetimeMs: number },
  signal: AbortSignal,
  assertKernel: RuntimeKernelFence,
  start: typeof startPreparedDatabasePreview = startPreparedDatabasePreview,
  bundle: () => Promise<Uint8Array> = () => getDatabaseWorkerBundle("preview"),
): Promise<PreviewRuntimeResult> {
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
    const [runtime] = await database.select().from(previewDatabaseRuntime)
      .where(eq(previewDatabaseRuntime.previewId, claim.previewId));
    const socket = AppDatabaseSocketIdentity.parse(runtime?.socket);
    if (!runtime?.imageId || socket.id !== claim.previewId || socket.resourceId !== evidence.binding.resourceId ||
        socket.projectId !== claim.projectId) throw new Error("Runtime preparation changed");
    const applicationBundle = await bundle();
    await held();
    await recordPreviewDatabaseEffect(database, claim, "start-application", assertKernel);
    attempted = true;
    const settings = await loadPreviewDatabaseApplicationSettings(database, claim, configuration.directory, assertKernel);
    await held();
    const result = await start({
      identity: { previewId: claim.previewId, projectId: claim.projectId, buildId: claim.buildId, claimToken: claim.token },
      framework: evidence.binding.framework,
      scope: { projectId: claim.projectId, resourceId: evidence.binding.resourceId, environment: "development" },
      imageId: runtime.imageId, socket, role: settings.role, appKey: settings.appKey,
      lifetimeMs: configuration.lifetimeMs, applicationBundle,
      ingress: configuration.ingress, ingressBundle: configuration.ingressBundle, signal, assertHeld: held,
      onStarted: async (resources, preparation): Promise<void> => {
        await held();
        if (preparation.imageId !== runtime.imageId) throw new Error("Startup image changed");
        await updatePreviewProgress(database, claim, { type: "starting", resources: { ...resources, preparation } });
        await held();
      },
    });
    await held();
    if (result.imageId !== runtime.imageId) throw new Error("Returned startup image changed");
    await acknowledgePreviewDatabaseEffect(database, claim, "start-application", {}, assertKernel);
    return result;
  } catch {
    if (attempted) {
      try { await assertKernel(); await interruptPreview(database, claim); }
      catch { /* Retain original intent and reservation when interruption cannot be acknowledged. */ }
    }
    throw new AppDatabaseError(409,
      "Preview application startup is unconfirmed. Preserve its saved runtime for explicit cleanup.");
  }
}
