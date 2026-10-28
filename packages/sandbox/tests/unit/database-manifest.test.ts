import { expect, test } from "bun:test";
import { readAppDatabaseManifest } from "../../src/databases/database-manifest";
const sql = {
  path: "drizzle/0000_initial.sql",
  content: "CREATE TABLE notes (id integer PRIMARY KEY);",
};
function source(
  database: Record<string, unknown> = {
    engine: "postgresql",
    adapter: "drizzle-postgres",
    migrations: [sql.path],
  },
): Array<{ path: string; content: string }> {
  return [
    {
      path: "wrenly.app.json",
      content: JSON.stringify({ version: 1, database }),
    },
    sql,
    {
      path: "drizzle/meta/_journal.json",
      content: JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [
          {
            idx: 0,
            version: "7",
            tag: "0000_initial",
            when: 1,
            breakpoints: true,
          },
        ],
      }),
    },
  ];
}
test("stateless source remains stateless; saved migration identity tracks exact bytes and adapter", () => {
  expect(readAppDatabaseManifest([sql], "nextjs")).toBeNull();
  const result = readAppDatabaseManifest(source(), "nextjs");
  expect(result?.files).toHaveLength(2);
  expect(result?.digest).toMatch(/^[a-f0-9]{64}$/);
  const edited = source().map((file) =>
    file.path === sql.path ? { ...file, content: file.content + "\n" } : file,
  );
  expect(readAppDatabaseManifest(edited, "nextjs")?.digest).not.toBe(
    result?.digest,
  );
  expect(() => readAppDatabaseManifest(source(), "laravel")).toThrow("adapter");
  expect(() => readAppDatabaseManifest(source(), "vue")).toThrow("adapter");
});
test("journal changes alter the reviewed digest and undeclared migrations cannot execute outside the review", () => {
  const baseline = readAppDatabaseManifest(source(), "nextjs");
  const changed = source().map((file) =>
    file.path.endsWith("_journal.json")
      ? { ...file, content: file.content.replace('"when":1', '"when":2') }
      : file,
  );
  expect(readAppDatabaseManifest(changed, "nextjs")?.digest).not.toBe(
    baseline?.digest,
  );
  expect(() =>
    readAppDatabaseManifest(
      source().filter((file) => !file.path.endsWith("_journal.json")),
      "nextjs",
    ),
  ).toThrow("journal");
  expect(() =>
    readAppDatabaseManifest(
      [
        ...source(),
        { path: "drizzle/unreviewed.sql", content: "DROP TABLE notes;" },
      ],
      "nextjs",
    ),
  ).toThrow("reviewed");
  expect(() =>
    readAppDatabaseManifest(
      source().map((file) =>
        file.path.endsWith("_journal.json")
          ? {
              ...file,
              content: file.content.replace("0000_initial", "different"),
            }
          : file,
      ),
      "nextjs",
    ),
  ).toThrow("reviewed");
});
test("declarations cannot smuggle endpoints, credentials, commands, traversal or missing source", () => {
  const declaration = {
    engine: "postgresql",
    adapter: "drizzle-postgres",
    migrations: [sql.path],
  };
  for (const extra of [
    { password: "secret" },
    { url: "postgresql://control" },
    { command: "sh" },
  ])
    expect(() =>
      readAppDatabaseManifest(source({ ...declaration, ...extra }), "nextjs"),
    ).toThrow();
  for (const migrations of [
    ["../control.sql"],
    ["drizzle/../control.sql"],
    [sql.path, sql.path],
    ["drizzle/missing.sql"],
    [],
  ])
    expect(() =>
      readAppDatabaseManifest(source({ ...declaration, migrations }), "nextjs"),
    ).toThrow();
  expect(() =>
    readAppDatabaseManifest(
      source().map((file) =>
        file.path === sql.path
          ? { ...file, content: "x".repeat(512 * 1024 + 1) }
          : file,
      ),
      "nextjs",
    ),
  ).toThrow("size limit");
});
test("Laravel declarations freeze PHP migration source without importing or executing it", () => {
  const path = "database/migrations/2026_10_19_000000_create_notes_table.php";
  const files = [
    {
      path: "wrenly.app.json",
      content: JSON.stringify({
        version: 1,
        database: {
          engine: "postgresql",
          adapter: "laravel",
          migrations: [path],
        },
      }),
    },
    {
      path,
      content: '<?php throw new Exception("must never execute on the host");',
    },
  ];
  expect(
    readAppDatabaseManifest(files, "laravel")?.manifest.database.adapter,
  ).toBe("laravel");
});


test("Laravel review binds bootstrap and provider bytes, independent of input ordering", () => {
  const migration = "database/migrations/2026_10_19_000000_create_notes.php";
  const files = [
    { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
      engine: "postgresql", adapter: "laravel", migrations: [migration],
    } }) },
    { path: migration, content: "<?php // reviewed migration" },
    { path: "bootstrap/app.php", content: "<?php // bootstrap" },
    { path: "app/Providers/AppServiceProvider.php", content: "<?php // provider" },
    { path: "composer.lock", content: "{}" },
  ];
  const reviewed = readAppDatabaseManifest(files, "laravel");
  expect(reviewed?.files).toHaveLength(1);
  expect(readAppDatabaseManifest([...files].reverse(), "laravel")?.digest).toBe(reviewed?.digest);
  for (const target of files) {
    const changed = files.map(file => file.path === target.path
      ? { ...file, content: file.content + "\n" } : file);
    expect(readAppDatabaseManifest(changed, "laravel")?.digest).not.toBe(reviewed?.digest);
  }
  expect(readAppDatabaseManifest([...files, { path: "config/app.php", content: "<?php" }], "laravel")?.digest).not.toBe(reviewed?.digest);
  expect(readAppDatabaseManifest(files.filter(file => file.path !== "composer.lock"), "laravel")?.digest).not.toBe(reviewed?.digest);
  expect(() => readAppDatabaseManifest([...files, {
    path: "public/large.txt", content: "x".repeat(2 * 1024 * 1024),
  }], "laravel")).toThrow("source exceeds");
});

test("a valid journal cannot hide an incompatible managed PostgreSQL client connection", () => {
  const files = [...source(), { path: "db/index.ts", content: "import postgres from 'postgres';const sql=postgres(process.env.DATABASE_URL || 'postgres://test:test@localhost/db');" }];
  expect(() => readAppDatabaseManifest(files, "nextjs")).toThrow("not DATABASE_URL");
  expect(readAppDatabaseManifest(files.map(file => file.path === "db/index.ts" ? { ...file, content: "import postgres from 'postgres';const sql=postgres();" } : file), "nextjs")).not.toBeNull();
});
