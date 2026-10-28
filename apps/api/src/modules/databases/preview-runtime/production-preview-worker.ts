/** Explicit host installation for database previews; imports never start work or expose routes. */
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import { previewDatabaseBindings, previewDatabaseRuntime, type db } from "@wrenly/db";
import { verifyPreviewHost } from "@wrenly/sandbox";
import { verifyDatabaseToolchain } from "@wrenly/sandbox/database-toolchain";
import type { ApiEnvironment } from "../../../config/api-environment";
import { verifyDatabaseSchema } from "../database-store";
import { runPreviewWorker } from "../../previews/execution/preview-worker";
import { acquirePreviewExecutorLock, type PreviewExecutorLock } from "../../previews/execution/preview-executor-lock";
import type { PreviewLifecycle } from "../../previews/execution/production-preview-worker";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { previewOrigin } from "../../previews/access/preview-access";
import { PREVIEW_COOKIE } from "../../previews/gateway/preview-gateway";
import { createDatabasePreviewWorkerServices } from "./runtime-worker";

const DOCKER_SETTLE_MS = 10_000;
const PREVIEW_LIFETIME_MS = 60 * 60 * 1000;
const MAX_INGRESS_BYTES = 2 * 1024 * 1024;

/** Caller must await stop before discarding this lifecycle; uncertain cleanup keeps its durable reservation. */
export async function startProductionDatabasePreviewWorker(
  database: typeof db, environment: ApiEnvironment, ingressBundle: Uint8Array,
): Promise<PreviewLifecycle> {
  if (environment.WRENLY_PREVIEW_ENABLED !== "true" || environment.WRENLY_AUTH_SECRET.length < 32 ||
      !ingressBundle.byteLength || ingressBundle.byteLength > MAX_INGRESS_BYTES)
    throw new Error("Database previews require validated local-preview configuration and trusted ingress.");
  if (process.platform !== "linux" || existsSync("/.dockerenv") || existsSync("/run/.containerenv") || process.env.container)
    throw new Error("Database previews require the API directly on a Linux Docker host with GNU flock.");
  await verifyDatabaseSchema(database);
  try {
    await database.select().from(previewDatabaseBindings).limit(1);
    await database.select().from(previewDatabaseRuntime).limit(1);
  } catch {
    throw new Error("Database preview persistence is unavailable. Apply checked-in migrations from packages/db before enabling it.");
  }
  await verifyDatabaseToolchain();
  const probe = await acquirePreviewExecutorLock({ previewId: crypto.randomUUID(), projectId: crypto.randomUUID(),
    buildId: crypto.randomUUID(), token: crypto.randomUUID() });
  await probe.release();
  await verifyPreviewHost();
  const locks = new Map<string, PreviewExecutorLock>();
  const key = (claim: PreviewClaim): string => `${claim.previewId}:${claim.token}`;
  const acquire = async (claim: PreviewClaim): Promise<void> => {
    if (!locks.has(key(claim))) locks.set(key(claim), await acquirePreviewExecutorLock(claim));
  };
  const services = createDatabasePreviewWorkerServices(database, {
    directory: environment.WRENLY_DATA_DIR, lifetimeMs: PREVIEW_LIFETIME_MS, ingressBundle,
    ingressFor: (claim) => ({ previewOrigin: previewOrigin(environment.WRENLY_PREVIEW_BASE_URL, claim.previewId),
      controlOrigin: environment.WRENLY_WEB_URL,
      capability: createHmac("sha256", environment.WRENLY_AUTH_SECRET).update(`preview-ingress:${key(claim)}`).digest("hex"),
      blockedCookieNames: [PREVIEW_COOKIE, "better-auth.session_token", "__Secure-better-auth.session_token",
        "better-auth.session_data", "__Secure-better-auth.session_data", "wrenly_session"],
    }),
  }, {
    acquire,
    assertHeld: (claim) => {
      const lock = locks.get(key(claim));
      if (!lock) throw new Error("Database preview executor lock is unavailable.");
      lock.assertHeld();
    },
    release: async (claim) => { await locks.get(key(claim))?.release(); locks.delete(key(claim)); },
    assertExternalQuiescent: async (claim) => {
      await acquire(claim);
      // The dead executor's kernel lock stays held while earlier Docker requests finish settling.
      await Bun.sleep(DOCKER_SETTLE_MS);
      locks.get(key(claim))!.assertHeld();
    },
  });
  const shutdown = new AbortController();
  const done = runPreviewWorker(services.dependencies, shutdown.signal);
  void done.catch(() => {});
  return { runtime: services.runtime, stop: async () => {
    shutdown.abort();
    const outcome = await Promise.allSettled([done]);
    // runPreviewWorker joins every managed task before settling recovery, including failure.
    const released = await Promise.allSettled([...locks.values()].map((lock) => lock.release()));
    locks.clear();
    if (released.some((result) => result.status === "rejected"))
      throw new Error("Database preview executor lock release is unconfirmed.");
    if (outcome[0]?.status === "rejected") throw outcome[0].reason;
  } };
}
