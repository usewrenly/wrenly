/** Explicit setup inspection records an exact existing resource; it never creates or resumes a publication. */
import { z } from "zod";
import type { db } from "@wrenly/db";
import type { ApiEnvironment } from "../../../config/api-environment";
import { ProductionPublishingReceipt } from "@wrenly/db/production-publishing-contract";
import { acquireDeploymentExecutorLock } from "../execution/deployment-executor-lock";
import {
  finishDeployment,
  renewDeploymentLease,
  type DeploymentClaim,
} from "../persistence/deployment-store";
import {
  claimInterruptedProductionSetup,
  acknowledgeRecoveredProductionSetup,
  loadProductionPublishingRuntime,
} from "../database-runtime/store";
import { loadProductionInspectionHostCredentials } from "../database-runtime/secrets";
import { productionStartInspectionConfiguration } from "../database-runtime/inspection-configuration";
import { inspectProductionSetupEffect } from "../database-runtime/setup-inspection";
const VERIFICATION_MS = 25000;
/** Only the selected original setup effect can be acknowledged. Absence and uncertainty leave its intent intact. */
export async function reconcileProductionSetup(
  database: typeof db,
  environment: ApiEnvironment,
  deploymentId: string,
  inspect: typeof inspectProductionSetupEffect = inspectProductionSetupEffect,
): Promise<void> {
  z.uuid().parse(deploymentId);
  const lock = await acquireDeploymentExecutorLock({
    deploymentId,
    token: crypto.randomUUID(),
  });
  let claim: DeploymentClaim | undefined;
  const cancelled = new AbortController(),
    signal = AbortSignal.any([
      cancelled.signal,
      AbortSignal.timeout(VERIFICATION_MS),
    ]);
  const assertHeld = async (): Promise<void> => {
    lock.assertHeld();
    signal.throwIfAborted();
    if (!claim) throw new Error("Inspection has no saved claim.");
    await renewDeploymentLease(database, claim);
    await loadProductionPublishingRuntime(database, claim);
    lock.assertHeld();
    signal.throwIfAborted();
  };
  // A single bounded read finishes before the 30-second claim lease. Serial checks
  // avoid a timer contending with this process's own non-waiting queue locks.
  try {
    claim = await claimInterruptedProductionSetup(database, deploymentId);
    const owned = claim;
    await assertHeld();
    const { binding, journal } = await loadProductionPublishingRuntime(
        database,
        owned,
      ),
      effect = journal.pending;
    if (!effect) throw new Error("Original setup effect is missing.");
    const credentials = await loadProductionInspectionHostCredentials({
      database,
      claim: owned,
      directory: environment.WRENLY_DATA_DIR,
    });
    const fact = await inspect({
      ...{ binding, journal, effect },
      signal,
      credentials: { host: credentials },
      ...([
        "broker-start",
        "service-create",
        "service-start",
        "application-start",
      ].includes(effect.step)
        ? {
            runtime: await productionStartInspectionConfiguration(
              database,
              environment,
              owned,
            ),
          }
        : {}),
      assertHeld,
    });
    if (!fact)
      throw new Error(
        "The setup resource is absent; its creation cannot be acknowledged.",
      );
    await assertHeld();
    await acknowledgeRecoveredProductionSetup(
      database,
      owned,
      ProductionPublishingReceipt.parse({
        effect,
        fact,
        completedAt: new Date().toISOString(),
      }),
    );
    await finishDeployment(database, owned, {
      status: "interrupted",
      code: "READINESS_UNCONFIRMED",
    });
  } catch {
    if (claim)
      await finishDeployment(database, claim, {
        status: "interrupted",
        code: "READINESS_UNCONFIRMED",
      }).catch(() => {});
    throw new Error(
      "Setup inspection could not confirm the original effect. Saved evidence is preserved; no creation or credential delivery was repeated.",
    );
  } finally {
    await lock.release();
  }
}
if (import.meta.main) {
  try {
    const [id, confirmation, ...extra] = Bun.argv.slice(2);
    if (
      !z.uuid().safeParse(id).success ||
      confirmation !== "--confirm-read-only-verification" ||
      extra.length
    )
      throw new Error(
        "Usage: bun run reconcile-production-setup DEPLOYMENT_UUID --confirm-read-only-verification",
      );
    const { parseApiEnvironment } =
      await import("../../../config/api-environment");
    const { db } = await import("@wrenly/db");
    await reconcileProductionSetup(db, parseApiEnvironment(process.env), id!);
    process.stdout.write(
      "The exact setup effect was verified. The publication remains interrupted; no later operation was started.\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Setup inspection failed."}\n`,
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
