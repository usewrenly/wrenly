import { expect, test } from "bun:test";
import { assertMigrationHistoryPrefix } from "./migration-history";
import { appDatabaseSource } from "../../../../../packages/db/tests/fixtures/app-database-source";
for (const framework of ["nextjs", "laravel"] as const)
  test(`applied history remains immutable (${framework})`, () => {
    const old = appDatabaseSource(framework);
    expect(() =>
      assertMigrationHistoryPrefix(old, old, framework),
    ).not.toThrow();
    const path =
      framework === "nextjs"
        ? "drizzle/0000_notes.sql"
        : "database/migrations/2026_10_24_000000_notes.php";
    const changed = old.map((file) =>
      file.path === path ? { ...file, content: file.content + "\n" } : file,
    );
    expect(() => assertMigrationHistoryPrefix(old, changed, framework)).toThrow(
      "already-applied",
    );
  });
test("Next.js accepts appended migration and refuses rewritten journal prefix", () => {
  const old = appDatabaseSource("nextjs");
  const next = old.map((file) => {
    if (file.path === "wrenly.app.json")
      return {
        ...file,
        content: JSON.stringify({
          version: 1,
          database: {
            engine: "postgresql",
            adapter: "drizzle-postgres",
            migrations: ["drizzle/0000_notes.sql", "drizzle/0001_extra.sql"],
          },
        }),
      };
    if (file.path.endsWith("_journal.json")) {
      const journal = JSON.parse(file.content);
      journal.entries.push({
        idx: 1,
        version: "7",
        tag: "0001_extra",
        when: 2,
        breakpoints: true,
      });
      return { ...file, content: JSON.stringify(journal) };
    }
    return file;
  });
  next.push({
    path: "drizzle/0001_extra.sql",
    content: "ALTER TABLE notes ADD COLUMN title text;",
  });
  expect(() => assertMigrationHistoryPrefix(old, next, "nextjs")).not.toThrow();
  const changed = next.map((file) => {
    if (!file.path.endsWith("_journal.json")) return file;
    const journal = JSON.parse(file.content);
    journal.entries[0].when = 0;
    return { ...file, content: JSON.stringify(journal) };
  });
  expect(() => assertMigrationHistoryPrefix(old, changed, "nextjs")).toThrow(
    "journal entries",
  );
});

test("format-only journal changes are caught before preview compatibility", () => {
  const original = appDatabaseSource("nextjs");
  const changed = original.map((file) =>
    file.path.endsWith("_journal.json")
      ? {
          ...file,
          content: JSON.stringify(JSON.parse(file.content), null, 2) + "\n",
        }
      : file,
  );
  expect(() =>
    assertMigrationHistoryPrefix(original, changed, "nextjs"),
  ).toThrow("reformatted");
});
