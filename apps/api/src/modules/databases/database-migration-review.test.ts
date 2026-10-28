import { expect, test } from "bun:test";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { readFrozenMigrationSource } from "./database-migration-review";

test("saved Laravel review refuses changed bootstrap bytes or another framework", () => {
  const path = "database/migrations/2026_10_23_000000_notes.php";
  const files = [
    { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
      engine: "postgresql", adapter: "laravel", migrations: [path],
    } }) },
    { path, content: "<?php // migration" },
    { path: "bootstrap/app.php", content: "<?php // original bootstrap" },
  ];
  const digest = readAppDatabaseManifest(files, "laravel")!.digest;
  expect(readFrozenMigrationSource(files, digest, "laravel").files).toEqual(files);
  expect(() => readFrozenMigrationSource(files, digest, "nextjs")).toThrow();
  expect(() => readFrozenMigrationSource(files.map(file => file.path === "bootstrap/app.php"
    ? { ...file, content: "<?php // changed bootstrap" } : file), digest, "laravel")).toThrow("source changed");
  expect(() => readFrozenMigrationSource(files, "f".repeat(64), "laravel")).toThrow("source changed");
});
