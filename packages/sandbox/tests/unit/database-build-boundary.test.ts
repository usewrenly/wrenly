import { expect, test } from "bun:test";
import { runSandbox } from "../../src/builds/build-runner";

// Source is deliberately not a runnable app: refusal must precede installation,
// build commands and progress events, without requiring a Docker daemon.
function databaseSource(stack: "nextjs" | "laravel"): Array<{ path: string; content: string }> {
  const migration = stack === "nextjs"
    ? "drizzle/0000_notes.sql"
    : "database/migrations/2026_10_23_000000_notes.php";
  return [
    { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
      engine: "postgresql", adapter: stack === "nextjs" ? "drizzle-postgres" : "laravel",
      migrations: [migration],
    } }) },
    { path: migration, content: stack === "nextjs" ? "CREATE TABLE notes(id integer);" : "<?php" },
    ...(stack === "nextjs" ? [{ path: "drizzle/meta/_journal.json", content: JSON.stringify({
      dialect: "postgresql", entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }],
    }) }] : []),
  ];
}

test.each(["nextjs", "laravel"] as const)("%s database builds cannot pass stateless validation", async (stack) => {
  const stages: string[] = [];
  const result = await runSandbox({
    projectId: crypto.randomUUID(), stack, files: databaseSource(stack),
    onStage: async (operation, state): Promise<void> => { stages.push(`${operation}:${state}`); },
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain("Select a ready Development database");
  expect(result.output).toBe("");
  expect(stages).toEqual([]);
});

test("malformed declarations cannot fall through to ordinary builds", async () => {
  for (const content of ["{", JSON.stringify({ version: 1, database: { url: "postgresql://control" } })]) {
    const result = await runSandbox({ projectId: crypto.randomUUID(), files: [
      { path: "wrenly.app.json", content },
    ] });
    expect(result.success).toBe(false);
    expect(result.error).toContain("manifest");
    expect(result.output).toBe("");
  }
});
