// Executes an already reviewed, bounded migration set on an isolated app connection.
// Verify the exact journal prefix under an advisory transaction lock before applying new files.
// Callers own authorization, backup/rehearsal and frozen-source verification; no public SQL console.
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { MigrationMeta } from "drizzle-orm/migrator";
const MAX_MIGRATIONS = 128;
const MAX_MIGRATION_BYTES = 512 * 1024;
const MIGRATION_LOCK_NAMESPACE = 926182;
/** Applies Drizzle's journal/file format without granting CREATE on the application database. */
export async function applyReviewedAppMigrations(
  database: PostgresJsDatabase,
  migrations: MigrationMeta[],
): Promise<void> {
  let bytes = 0,
    previous = -1;
  if (!migrations.length || migrations.length > MAX_MIGRATIONS)
    throw new Error("Invalid migration count");
  for (const migration of migrations) {
    if (
      !/^[a-f0-9]{64}$/.test(migration.hash) ||
      !Number.isSafeInteger(migration.folderMillis) ||
      migration.folderMillis <= previous ||
      !migration.sql.length
    )
      throw new Error("Invalid reviewed migration identity");
    previous = migration.folderMillis;
    for (const statement of migration.sql)
      bytes += Buffer.byteLength(statement);
  }
  if (bytes > MAX_MIGRATION_BYTES)
    throw new Error("Reviewed migration source exceeds bounds");
  await database.transaction(async (tx) => {
    const [lock] = await tx.execute(
      sql`select pg_catalog.pg_try_advisory_xact_lock(${MIGRATION_LOCK_NAMESPACE}, 1) as held`,
    );
    if (lock?.held !== true)
      throw new Error("Another migration executor is active");
    await tx.execute(
      sql`create table if not exists public.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
    );
    const applied = await tx.execute(
      sql`select hash,created_at::text as timestamp from public.__drizzle_migrations order by id limit 129 for update`,
    );
    if (
      applied.length > migrations.length ||
      applied.some(
        (row, index) =>
          row.hash !== migrations[index]?.hash ||
          row.timestamp !== String(migrations[index]?.folderMillis),
      )
    )
      throw new Error("Applied migrations are not the exact reviewed prefix");
    for (const migration of migrations.slice(applied.length)) {
      for (const statement of migration.sql)
        if (statement.trim()) await tx.execute(sql.raw(statement));
      await tx.execute(
        sql`insert into public.__drizzle_migrations (hash,created_at) values (${migration.hash},${migration.folderMillis})`,
      );
    }
    const actual = await tx.execute(
      sql`select hash,created_at::text as timestamp from public.__drizzle_migrations order by id limit 129`,
    );
    if (
      actual.length !== migrations.length ||
      actual.some(
        (row, index) =>
          row.hash !== migrations[index]?.hash ||
          row.timestamp !== String(migrations[index]?.folderMillis),
      )
    )
      throw new Error("Actual journal differs from the reviewed set");
  });
}
