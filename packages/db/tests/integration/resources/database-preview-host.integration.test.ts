/** Explicit opt-in host probe and empty worker installation against disposable control storage only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as schema from "../../../src/schema";
import { parseApiEnvironment } from "../../../../../apps/api/src/config/api-environment";
import { startProductionDatabaseModule } from "../../../../../apps/api/src/modules/databases/production-module";
import { startProductionDatabasePreviewWorker } from "../../../../../apps/api/src/modules/databases/preview-runtime/production-preview-worker";

const url = process.env.WRENLY_TEST_DATABASE_PREVIEW_HOST_URL;
const enabled = process.env.WRENLY_TEST_DATABASE_PREVIEW_HOST === "true" && Boolean(url);
if (url) {
  const parsed = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(parsed.hostname) || parsed.pathname !== "/wrenly_database_preview_host_test")
    throw new Error("Host acceptance requires a disposable local wrenly_database_preview_host_test database.");
}
(enabled ? describe : describe.skip)("database preview host installation", () => {
  const client = postgres(url ?? "postgresql://localhost/wrenly_database_preview_host_test", { onnotice: () => {} });
  const database = drizzle(client, { schema });
  let directory = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "wrenly-database-preview-host-"));
    await migrate(database, { migrationsFolder: resolve(import.meta.dir, "../../../migrations") });
    if ((await database.select().from(schema.previews)).length || (await database.select().from(schema.appDatabases)).length)
      throw new Error("Use an empty disposable host fixture; this test must not adopt existing work.");
  }, 30_000);
  afterAll(async () => { await client.end(); await rm(directory, { recursive: true, force: true }); });
  test("checks actual host/toolchains and starts/stops without creating app resources", async () => {
    const environment = parseApiEnvironment({ WRENLY_DATABASE_URL: url,
      WRENLY_DATA_DIR: directory, WRENLY_AUTH_SECRET: "fixture-host-auth-secret-with-at-least-32-characters",
      WRENLY_APP_URL: "http://localhost:3002", WRENLY_WEB_URL: "http://localhost:3000", WRENLY_APP_DATABASES_ENABLED: "true", WRENLY_PREVIEW_ENABLED: "true" });
    const bundle = await Bun.build({ target: "bun", env: "disable",
      entrypoints: [resolve(import.meta.dir, "../../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts")] });
    if (!bundle.success || !bundle.outputs[0]) throw new Error("Trusted ingress fixture bundle failed");
    const ingress = new Uint8Array(await bundle.outputs[0].arrayBuffer());
    await expect(startProductionDatabasePreviewWorker(database, { ...environment, WRENLY_PREVIEW_ENABLED: "false" }, ingress))
      .rejects.toThrow("configuration");
    await expect(startProductionDatabasePreviewWorker(database, environment, new Uint8Array())).rejects.toThrow("configuration");
    const worker = await startProductionDatabaseModule(database, environment, ingress);
    try {
      expect(worker.runtime(crypto.randomUUID())).toBeNull();
      expect(await database.select().from(schema.previews)).toHaveLength(0);
      expect(await database.select().from(schema.appDatabases)).toHaveLength(0);
    } finally { await worker.stop(); }
    expect(await database.select().from(schema.appDatabaseOperations)).toHaveLength(0);
  }, 30_000);
});
