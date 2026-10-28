/** Development database host lifecycle; construction is explicit and all started services have an awaited cleanup owner. */
import { appDatabases, type db } from "@wrenly/db";
import { join } from "node:path";
import { loadDatabaseKey, decryptDatabaseSecret } from "./database-secrets";
import { DatabaseCredentials } from "./database-contract";
import type { ApiEnvironment } from "../../config/api-environment";
import type { PreviewLifecycle } from "../previews/execution/production-preview-worker";
import { verifyDatabaseToolchain } from "@wrenly/sandbox/database-toolchain";
import { verifyDatabaseSchema } from "./database-store";
import { getDatabaseWorkerBundle } from "./database-worker-bundle";
import { acquireDatabaseExecutorLock } from "./database-executor-lock";
import { createProductionDatabaseWorker } from "./production-database-worker";
import { startProductionDatabasePreviewWorker } from "./preview-runtime/production-preview-worker";
type Lifecycle = { stop: () => Promise<void> };
interface Adapters {
  verify: (database: typeof db, directory: string) => Promise<void>;
  previews: typeof startProductionDatabasePreviewWorker;
  resources: (database: typeof db, directory: string) => Lifecycle | Promise<Lifecycle>;
}
const defaults: Adapters = {
  verify: async (database, directory) => {
    await verifyDatabaseSchema(database);
    await verifyDatabaseToolchain();
    const resources = await database.select({ id: appDatabases.id, environment: appDatabases.environment, secrets: appDatabases.secrets }).from(appDatabases);
    const key = await loadDatabaseKey(join(directory, "database-keys"), resources.length > 0);
    try {
      for (const resource of resources) DatabaseCredentials.parse(JSON.parse(decryptDatabaseSecret(resource.secrets, key, `${resource.id}:${resource.environment}`)));
    } catch { throw new Error("Stored application database credentials could not be verified. Restore the original instance data and encryption key."); }
    await Promise.all((["administrator", "migration", "query", "application", "preview"] as const).map(kind => getDatabaseWorkerBundle(kind)));
    const lock = await acquireDatabaseExecutorLock({ id: crypto.randomUUID(), resourceId: crypto.randomUUID(), projectId: crypto.randomUUID(), token: crypto.randomUUID() });
    await lock.release();
  },
  previews: startProductionDatabasePreviewWorker,
  resources: createProductionDatabaseWorker,
};

/** Verifies all shared prerequisites before resource claims; partial startup always awaits owned service shutdown. */
export async function startProductionDatabaseModule(database: typeof db, environment: ApiEnvironment,
  ingress: Uint8Array, adapters: Adapters = defaults): Promise<PreviewLifecycle> {
  if (environment.WRENLY_APP_DATABASES_ENABLED !== "true" || environment.WRENLY_PREVIEW_ENABLED !== "true")
    throw new Error("Development database activation requires explicit opt-in and local previews.");
  await adapters.verify(database, environment.WRENLY_DATA_DIR);
  let previews: PreviewLifecycle | undefined, resources: Lifecycle | undefined;
  try {
    previews = await adapters.previews(database, environment, ingress);
    resources = await adapters.resources(database, environment.WRENLY_DATA_DIR);
  } catch (error) {
    const results = await Promise.allSettled([previews?.stop(), resources?.stop()]);
    if (results.some(result => result.status === "rejected")) throw new Error("Database startup cleanup is unconfirmed.", { cause: error });
    throw error;
  }
  const runningPreviews = previews, runningResources = resources;
  let stopping: Promise<void> | undefined;
  return { runtime: id => runningPreviews.runtime(id), stop: () => {
    stopping ??= (async (): Promise<void> => {
      const results = await Promise.allSettled([runningPreviews.stop(), runningResources.stop()]);
      if (results.some(result => result.status === "rejected")) throw new Error("Database service cleanup is unconfirmed. Review saved operations before restarting.");
    })();
    return stopping;
  } };
}
