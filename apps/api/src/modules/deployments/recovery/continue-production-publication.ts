/** Explicitly continues only never-started runtime steps of the original saved publication. */
import { z } from "zod";
import type { db } from "@wrenly/db";
import type { ApiEnvironment } from "../../../config/api-environment";
import { acquireDeploymentExecutorLock } from "../execution/deployment-executor-lock";
import {
  finishDeployment,
  renewDeploymentLease,
  type DeploymentClaim,
} from "../persistence/deployment-store";
import {
  claimInterruptedProductionContinuation,
  loadProductionPublishingRuntime,
} from "../database-runtime/store";
import { loadProductionInspectionHostCredentials } from "../database-runtime/secrets";
import { productionStartInspectionConfiguration } from "../database-runtime/inspection-configuration";
import { inspectCompletedProductionEffects } from "../database-runtime/inspect-completed";
import { createProductionRuntimeServices } from "../database-runtime/services";
import { executeProductionRuntimeCoordinator } from "../database-runtime/executor";
const DEADLINE_MS = 5 * 60 * 1000;
const HEARTBEAT_MS = 10000;
interface ContinuationAdapters {
  inspect: typeof inspectCompletedProductionEffects;
  services: typeof createProductionRuntimeServices;
}
/** No source push, image upload or migration is replayed. Every unfinished remote call still needs its own durable intent. */
export async function continueProductionPublication(
  database: typeof db,
  environment: ApiEnvironment,
  deploymentId: string,
  adapters: ContinuationAdapters = {
    inspect: inspectCompletedProductionEffects,
    services: createProductionRuntimeServices,
  },
): Promise<void> {
  z.uuid().parse(deploymentId);
  const lock = await acquireDeploymentExecutorLock({
    deploymentId,
    token: crypto.randomUUID(),
  });
  const cancelled = new AbortController();
  const signal = AbortSignal.any([
    cancelled.signal,
    AbortSignal.timeout(DEADLINE_MS),
  ]);
  let claim: DeploymentClaim | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let heartbeat: Promise<void> | undefined;
  try {
    if (!environment.WRENLY_DEPLOY_ENCRYPTION_KEY)
      throw new Error("Restore the original deployment encryption key.");
    claim = await claimInterruptedProductionContinuation(
      database,
      deploymentId,
    );
    const owned = claim;
    const assertHeld = async (): Promise<void> => {
      signal.throwIfAborted();
      lock.assertHeld();
      if (heartbeat) await heartbeat;
      await loadProductionPublishingRuntime(database, owned);
      signal.throwIfAborted();
      lock.assertHeld();
    };
    timer = setInterval(() => {
      heartbeat ??= renewDeploymentLease(database, owned)
        .catch(() => {
          cancelled.abort();
        })
        .finally(() => {
          heartbeat = undefined;
        });
    }, HEARTBEAT_MS);
    const runtime = await productionStartInspectionConfiguration(
      database,
      environment,
      owned,
    );
    const saved = await loadProductionPublishingRuntime(database, owned);
    const host = await loadProductionInspectionHostCredentials({
      database,
      claim: owned,
      directory: environment.WRENLY_DATA_DIR,
    });
    await adapters.inspect({
      ...saved,
      signal,
      credentials: { host },
      runtime,
      assertHeld,
    });
    await assertHeld();
    const url = await executeProductionRuntimeCoordinator(
      adapters.services({
        database,
        claim: owned,
        directory: environment.WRENLY_DATA_DIR,
        deploymentEncryptionKey: environment.WRENLY_DEPLOY_ENCRYPTION_KEY,
        ...runtime,
        assertHeld,
      }),
      signal,
    );
    await assertHeld();
    await finishDeployment(database, owned, { status: "success", url });
  } catch {
    cancelled.abort();
    clearInterval(timer);
    await heartbeat;
    if (claim)
      await finishDeployment(database, claim, {
        status: "interrupted",
        code: "READINESS_UNCONFIRMED",
      }).catch(() => {});
    throw new Error(
      "Production continuation could not be confirmed. Saved receipts and pending effects are preserved; inspect the original operation before continuing.",
    );
  } finally {
    clearInterval(timer);
    await heartbeat;
    await lock.release();
  }
}
if (import.meta.main) {
  try {
    const [id, confirm, ...extra] = Bun.argv.slice(2);
    if (
      !z.uuid().safeParse(id).success ||
      confirm !== "--confirm-continue-original-publication" ||
      extra.length
    )
      throw new Error(
        "Usage: bun run continue-production-publication DEPLOYMENT_UUID --confirm-continue-original-publication",
      );
    const { parseApiEnvironment } =
      await import("../../../config/api-environment");
    const { db } = await import("@wrenly/db");
    await continueProductionPublication(
      db,
      parseApiEnvironment(process.env),
      id!,
    );
    process.stdout.write(
      "The original Production publication completed with a verified public route.\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production continuation failed."}\n`,
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
