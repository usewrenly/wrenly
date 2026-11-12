/** Explicit final-read recovery. No Git push, registry upload, service start or application SQL is performed here. */
import { z } from "zod";
import type { db } from "@wrenly/db";
import type { ApiEnvironment } from "../../../config/api-environment";
import { ProductionPublishingReceipt } from "@wrenly/db/production-publishing-contract";
import { createDeploymentProviderClient } from "@wrenly/deploy";
import { acquireDeploymentExecutorLock } from "../execution/deployment-executor-lock";
import {
  finishDeployment,
  loadDeploymentExecution,
  renewDeploymentLease,
  type DeploymentClaim,
} from "../persistence/deployment-store";
import {
  claimInterruptedProductionRoute,
  acknowledgeRecoveredProductionRoute,
  loadProductionPublishingRuntime,
} from "../database-runtime/store";
import { loadProductionPublishingRuntimeSecrets } from "../database-runtime/secrets";
import { verifyProductionRouteEffect } from "../database-runtime/route-adapter";
const HEARTBEAT_MS = 10_000;
const VERIFICATION_TIMEOUT_MS = 90_000;
interface RecoveryAdapters {
  verify: typeof verifyProductionRouteEffect;
}
/** Caller must explicitly confirm inspection; this recovers the original publication rather than creating another one. */
export async function reconcileProductionRoute(
  database: typeof db,
  environment: ApiEnvironment,
  deploymentId: string,
  adapters: RecoveryAdapters = { verify: verifyProductionRouteEffect },
): Promise<void> {
  z.uuid().parse(deploymentId);
  const lock = await acquireDeploymentExecutorLock({
    deploymentId,
    token: crypto.randomUUID(),
  });
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
  ]);
  let claim: DeploymentClaim | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    heartbeat: Promise<void> | undefined;
  let stage = "configuration";
  try {
    if (
      environment.WRENLY_PRODUCTION_DATABASES_ENABLED !== "true" ||
      !environment.WRENLY_DEPLOY_ENCRYPTION_KEY ||
      !environment.WRENLY_COOLIFY_API_KEY ||
      !environment.WRENLY_COOLIFY_API_URL ||
      !environment.WRENLY_PRODUCTION_INGRESS_IMAGE ||
      !environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID
    )
      throw new Error(
        "Restore the original enabled Production publishing configuration before reconciliation.",
      );
    stage = "claim";
    claim = await claimInterruptedProductionRoute(database, deploymentId);
    const owned = claim;
    timer = setInterval(() => {
      if (!heartbeat)
        heartbeat = renewDeploymentLease(database, owned)
          .catch(() => {
            controller.abort();
          })
          .finally(() => {
            heartbeat = undefined;
          });
    }, HEARTBEAT_MS);
    const assertHeld = async (): Promise<void> => {
      signal.throwIfAborted();
      lock.assertHeld();
      await loadDeploymentExecution(database, owned);
      signal.throwIfAborted();
    };
    stage = "saved placement";
    const { deployment, resources } = await loadDeploymentExecution(
      database,
      owned,
    );
    if (
      resources.coolifyInstanceUrl !==
        new URL(environment.WRENLY_COOLIFY_API_URL).origin ||
      resources.coolifyServerUuid !== environment.WRENLY_COOLIFY_SERVER_UUID ||
      resources.coolifyProjectUuid !==
        environment.WRENLY_COOLIFY_PROJECT_UUID ||
      resources.coolifyEnvironmentName !==
        environment.WRENLY_COOLIFY_ENVIRONMENT ||
      resources.registryOrigin !==
        new URL(environment.WRENLY_REGISTRY_URL!).origin ||
      resources.registryNamespace !== environment.WRENLY_REGISTRY_NAMESPACE ||
      !deployment.artifactImageId ||
      !deployment.registryRepository ||
      !deployment.registryDigest ||
      !["nextjs", "laravel"].includes(deployment.stack)
    )
      throw new Error("Production publishing placement or artifact changed.");
    const { binding, journal } = await loadProductionPublishingRuntime(
      database,
      owned,
    );
    const savedRoute = journal.completed.at(-1);
    const effect = journal.pending ?? savedRoute?.effect;
    if (!effect || effect.step !== "route-verify")
      throw new Error("Missing final route intent.");
    const proofJournal = journal.pending
      ? journal
      : {
          ...journal,
          completed: journal.completed.slice(0, -1),
          pending: effect,
        };
    stage = "credential authentication";
    const credentials = await loadProductionPublishingRuntimeSecrets({
      database,
      claim: owned,
      directory: environment.WRENLY_DATA_DIR,
      deploymentEncryptionKey: environment.WRENLY_DEPLOY_ENCRYPTION_KEY,
    });
    stage = "read-only route verification";
    const fact = await adapters.verify({
      binding,
      journal: proofJournal,
      effect,
      signal,
      credentials,
      assertHeld,
      client: createDeploymentProviderClient({
        origin: resources.coolifyInstanceUrl,
        token: environment.WRENLY_COOLIFY_API_KEY,
        authentication: "Bearer",
      }),
      images: {
        framework: deployment.stack as "nextjs" | "laravel",
        appImageId: deployment.artifactImageId,
        appImage: `${deployment.registryRepository}@${deployment.registryDigest}`,
        ingressImage: environment.WRENLY_PRODUCTION_INGRESS_IMAGE,
      },
      ingressImageId: environment.WRENLY_PRODUCTION_INGRESS_IMAGE_ID,
    });
    await assertHeld();
    if (!fact || fact.step !== "route-verify")
      throw new Error(
        "Production route is not verified; retain the saved operation.",
      );
    stage = "route acknowledgement";
    if (journal.pending)
      await acknowledgeRecoveredProductionRoute(
        database,
        owned,
        ProductionPublishingReceipt.parse({
          effect,
          fact,
          completedAt: new Date().toISOString(),
        }),
      );
    else if (
      savedRoute?.fact.step !== "route-verify" ||
      savedRoute.fact.url !== fact.url ||
      savedRoute.fact.sourceSha256 !== fact.sourceSha256
    )
      throw new Error("Previously verified route changed.");
    await assertHeld();
    await finishDeployment(database, owned, {
      status: "success",
      url: fact.url,
    });
  } catch {
    if (claim)
      await finishDeployment(database, claim, {
        status: "interrupted",
        code: "READINESS_UNCONFIRMED",
      }).catch(() => {});
    throw new Error(
      `Production route could not be reconciled during ${stage}. Its saved effects are preserved; no publishing mutation was repeated.`,
    );
  } finally {
    clearInterval(timer);
    await heartbeat;
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
        "Usage: bun run reconcile-production-route DEPLOYMENT_UUID --confirm-read-only-verification",
      );
    const { parseApiEnvironment } =
      await import("../../../config/api-environment");
    const { db } = await import("@wrenly/db");
    await reconcileProductionRoute(db, parseApiEnvironment(process.env), id!);
    process.stdout.write(
      "The exact Production runtime and route were verified; the original publication is now successful.\n",
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Production route reconciliation failed."}\n`,
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
