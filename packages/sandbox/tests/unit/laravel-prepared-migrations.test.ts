import { expect, test } from "bun:test";
import { runPreparedLaravelDatabaseMigrations } from "../../src/databases/laravel-migrations";
import { readAppDatabaseManifest } from "../../src/databases/database-manifest";
import { laravelFixture } from "../laravel-fixture";

test("prepared Laravel migration identity rejects a different source or operation before Docker", async () => {
  const operationId = crypto.randomUUID();
  const migrationPath = "database/migrations/2026_10_23_000000_notes.php";
  const files = [...laravelFixture(), { path: migrationPath, content: "<?php // saved migration" },
    { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
      engine: "postgresql", adapter: "laravel", migrations: [migrationPath],
    } }) }];
  const digest = readAppDatabaseManifest(files, "laravel")!.digest;
  let effects = 0;
  const effect = async (): Promise<void> => { effects++; };
  const input: Parameters<typeof runPreparedLaravelDatabaseMigrations>[0] = {
    scope: { resourceId: operationId, projectId: crypto.randomUUID(), environment: "development" },
    operationId, files, migrationDigest: digest, journalBundle: new Uint8Array([1]),
    socket: { id: operationId, resourceId: operationId, projectId: "", containerId: "fixture",
      volumeName: `wrenly-database-socket-${operationId}`, imageId: `sha256:${"a".repeat(64)}` },
    role: { user: `wrenly_${operationId.replaceAll("-", "")}_migrate`, password: "b".repeat(64) },
    preparedImage: { imageId: `sha256:${"c".repeat(64)}`, preparationId: operationId, migrationDigest: digest },
    fence: { assertHeld: effect, beforeEffect: effect, acknowledgeEffect: effect }, signal: new AbortController().signal,
  };
  for (const preparedImage of [
    { ...input.preparedImage, migrationDigest: "d".repeat(64) },
    { ...input.preparedImage, preparationId: crypto.randomUUID() },
    { ...input.preparedImage, imageId: "mutable:latest" },
  ]) await expect(runPreparedLaravelDatabaseMigrations({ ...input, preparedImage })).rejects.toThrow("source changed");
  await expect(runPreparedLaravelDatabaseMigrations({ ...input, files: files.map(file =>
    file.path === "bootstrap/app.php" ? { ...file, content: file.content + "\n" } : file) })).rejects.toThrow("source changed");
  expect(effects).toBe(0);
});
