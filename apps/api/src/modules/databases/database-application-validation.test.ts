import { expect, test } from "bun:test";
import { validateFreshDatabaseApplication } from "./database-application-validation";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";

test("fresh validation rejects stale migrations and non-disposable identities before acquiring authority", async () => {
  const files = [
    { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
      engine: "postgresql", adapter: "drizzle-postgres", migrations: ["drizzle/0000_notes.sql"],
    } }) },
    { path: "drizzle/0000_notes.sql", content: "CREATE TABLE notes(id integer PRIMARY KEY);" },
    { path: "drizzle/meta/_journal.json", content: JSON.stringify({ dialect: "postgresql",
      entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }] }) },
  ];
  let effects = 0;
  const effect = async (): Promise<void> => { effects++; };
  const request: Parameters<typeof validateFreshDatabaseApplication>[0] = {
    framework: "nextjs", projectId: crypto.randomUUID(), sourceResourceId: crypto.randomUUID(), operationId: crypto.randomUUID(),
    files, migrationDigest: readAppDatabaseManifest(files, "nextjs")!.digest,
    imageId: `sha256:${"a".repeat(64)}`, remainingMs: 60_000, signal: new AbortController().signal,
    fence: { assertHeld: effect, beforeEffect: effect, acknowledgeEffect: effect },
    cleanup: { assertHeld: effect, beforeCleanup: effect, acknowledgeCleanup: effect },
  };
  for (const invalid of [
    { ...request, sourceResourceId: request.operationId },
    { ...request, migrationDigest: "b".repeat(64) },
    { ...request, imageId: "mutable:latest" },
    { ...request, remainingMs: 300_001 },
    { ...request, files: files.map(file => file.path.endsWith(".sql") ? { ...file, content: file.content + "\n" } : file) },
  ]) await expect(validateFreshDatabaseApplication(invalid)).rejects.toThrow("saved application migration identity");
  expect(effects).toBe(0);
});
