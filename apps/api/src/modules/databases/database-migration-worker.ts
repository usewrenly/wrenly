// Trusted migration execution/journal verification bundle; runs in a socket-only Docker helper, never imports PHP.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { applyReviewedAppMigrations } from "@wrenly/db/app-database-migrations";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { DATABASE_SOCKET_PATH } from "@wrenly/sandbox/database-resource-policy";
const MAX_INPUT_BYTES = 65536;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 600 * 1024;
const Input = z
  .object({
    resourceId: z.string().uuid(),
    user: z.string(),
    password: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    paths: z
      .array(
        z
          .string()
          .regex(/^drizzle\/(?:[a-zA-Z0-9_-]+\.sql|meta\/_journal\.json)$/),
      )
      .min(2)
      .max(129),
  })
  .strict()
  .or(z.object({
    framework: z.literal("laravel"),
    resourceId: z.string().uuid(),
    user: z.string(),
    password: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    paths: z.array(z.string().max(256).regex(/^database\/migrations\/[a-zA-Z0-9_-]+\.php$/)).min(1).max(128),
  }).strict());
async function readFrozenFile(path: string): Promise<string> {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index++) {
    const info = await lstat(join("/app", ...parts.slice(0, index)));
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe migration directory");
  }
  const file = await open(
    join("/app", path),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES)
      throw new Error("Migration file exceeds bounds");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
let stage = "input";
async function main(): Promise<void> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = Bun.stdin.stream().getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_INPUT_BYTES) throw new Error("Input too large");
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const input = Input.parse(
    JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
  );
  if (
    input.user !== `wrenly_${input.resourceId.replaceAll("-", "")}_migrate` ||
    new Set(input.paths).size !== input.paths.length
  )
    throw new Error("Invalid migration identity");
  if ("framework" in input && input.framework === "laravel") {
    // Generated PHP can print a completion marker or exit early. Only this separate,
    // trusted process reads the native journal without booting application code.
    stage = "laravel-journal";
    const client = postgres({ path: DATABASE_SOCKET_PATH, database: "app",
      username: input.user, password: input.password, max: 1, connect_timeout: 3,
      idle_timeout: 1, prepare: false, onnotice: () => {} });
    try {
      const journal = pgTable("migrations", { migration: text("migration").notNull() });
      const rows = await drizzle(client).select({ migration: journal.migration }).from(journal).limit(129);
      const expected = input.paths.map(path => path.slice("database/migrations/".length, -4)).sort();
      const actual = rows.map(row => row.migration).sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Native Laravel journal differs from review");
      process.stdout.write("WRENLY_DATABASE_MIGRATIONS_APPLIED_V1\n");
    } finally { await client.end({ timeout: 1 }); }
    return;
  }
  stage = "source";
  const files = await Promise.all(
    ["wrenly.app.json", ...input.paths].map(async (path) => ({
      path,
      content: await readFrozenFile(path),
    })),
  );
  if (
    files.reduce((total, file) => total + Buffer.byteLength(file.content), 0) >
    MAX_SOURCE_BYTES
  )
    throw new Error("Migration source exceeds bounds");
  const manifest = readAppDatabaseManifest(files, "nextjs");
  if (
    !manifest ||
    manifest.digest !== input.digest ||
    JSON.stringify(manifest.files.map((file) => file.path).sort()) !==
      JSON.stringify([...input.paths].sort())
  )
    throw new Error("Reviewed migration source changed");
  const expected = readMigrationFiles({ migrationsFolder: "/app/drizzle" });
  stage = "connect";
  const client = postgres({
    path: DATABASE_SOCKET_PATH,
    database: "app",
    username: input.user,
    password: input.password,
    max: 1,
    connect_timeout: 3,
    idle_timeout: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    const database = drizzle(client, {
      logger: {
        logQuery(query: string): void {
          const text = query.trim().toLowerCase();
          stage = text.startsWith("create schema")
            ? "create-schema"
            : text.startsWith("create table")
              ? "create-journal-or-table"
              : text.startsWith('insert into "public"."__drizzle_migrations"')
                ? "journal-insert"
                : text.startsWith("select")
                  ? "journal-read"
                  : "migration-statement";
        },
      },
    });
    stage = "session-limits";
    await database.execute(sql`set statement_timeout = '30000ms'`);
    await database.execute(sql`set lock_timeout = '2000ms'`);
    await database.execute(
      sql`set idle_in_transaction_session_timeout = '10000ms'`,
    );
    stage = "execute";
    await applyReviewedAppMigrations(database, expected);
    stage = "journal";
    const journal = await database.execute(
      sql`select hash,created_at::text as timestamp from public.__drizzle_migrations order by id limit 1025`,
    );
    if (
      journal.length !== expected.length ||
      journal.some(
        (row, index) =>
          row.hash !== expected[index]?.hash ||
          row.timestamp !== String(expected[index]?.folderMillis),
      )
    )
      throw new Error("Actual migration journal differs from the reviewed set");
    process.stdout.write("WRENLY_DATABASE_MIGRATIONS_APPLIED_V1\n");
  } finally {
    await client.end({ timeout: 1 });
  }
}
const timer = setTimeout(() => {
  process.stderr.write("DATABASE_MIGRATION_DEADLINE\n");
  process.exit(1);
}, 60000);
try {
  await main();
} catch (error) {
  let detail: unknown = error,
    code = "UNKNOWN";
  let category = "unclassified";
  for (
    let depth = 0;
    depth < 4 && detail && typeof detail === "object";
    depth++
  ) {
    if ("message" in detail && typeof detail.message === "string") {
      if (detail.message.includes("unsupported startup parameter"))
        category = "startup-parameter";
      else if (detail.message.includes("bind message supplies"))
        category = "parameter-count";
      else if (detail.message.includes("insufficient data left"))
        category = "wire-length";
      else if (detail.message.includes("prepared statement"))
        category = "prepared-state";
      else if (detail.message.includes("invalid message format"))
        category = "wire-format";
    }
    if (
      "code" in detail &&
      typeof detail.code === "string" &&
      /^[A-Z0-9]{5}$/.test(detail.code)
    ) {
      code = detail.code;
      break;
    }
    detail = "cause" in detail ? detail.cause : undefined;
  }
  process.stderr.write(
    `DATABASE_MIGRATION_FAILED:${stage}:${code}:${category}\n`,
  );
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
}
