import { expect, test } from "bun:test";
import {
  buildRuntimeArtifact,
  prepareDatabaseValidationArtifact,
} from "../../src/artifacts/runtime-artifact";
import { readAppDatabaseManifest } from "../../src/databases/database-manifest";
import {
  LARAVEL_BUILD_COMMAND,
  LARAVEL_COMPILE_COMMAND,
} from "../../src/source-policy/laravel-runtime";
test("database image preparation cannot replace stateless validation or accept changed migrations", async () => {
  const files = [
    {
      path: "wrenly.app.json",
      content: JSON.stringify({
        version: 1,
        database: {
          engine: "postgresql",
          adapter: "drizzle-postgres",
          migrations: ["drizzle/0000_notes.sql"],
        },
      }),
    },
    {
      path: "drizzle/0000_notes.sql",
      content: "CREATE TABLE notes(id integer PRIMARY KEY);",
    },
    {
      path: "drizzle/meta/_journal.json",
      content: JSON.stringify({
        dialect: "postgresql",
        entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }],
      }),
    },
  ];
  expect(readAppDatabaseManifest(files, "nextjs")).not.toBeNull();
  let effects = 0;
  const input = {
    deploymentId: crypto.randomUUID(),
    stack: "nextjs" as const,
    files,
    signal: new AbortController().signal,
    beforeEffect: async (): Promise<void> => {
      effects++;
    },
  };
  await expect(buildRuntimeArtifact(input)).rejects.toThrow(
    "database preparation",
  );
  await expect(
    prepareDatabaseValidationArtifact({
      ...input,
      migrationDigest: "f".repeat(64),
    }),
  ).rejects.toThrow("database preparation");
  expect(effects).toBe(0);
  expect(LARAVEL_BUILD_COMMAND.at(-1)).toContain("bun /wrenly/verify.ts");
  expect(LARAVEL_COMPILE_COMMAND.at(-1)).not.toContain("bun /wrenly/verify.ts");
  expect(LARAVEL_COMPILE_COMMAND.at(-1)).toContain("php artisan view:cache");
});
