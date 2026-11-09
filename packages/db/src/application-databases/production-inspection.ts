/** Fixed, read-only metadata inspection for the setup credential on a separate PostgreSQL cluster. */
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
const Metadata = z
  .object({
    cluster_id: z.string().regex(/^[0-9]{1,20}$/),
    database_name: z.string().min(1).max(63),
    role_name: z.string().min(1).max(63),
    server_version: z.number().int().min(170000).max(179999),
    replica: z.boolean(),
    create_role: z.boolean(),
    create_database: z.boolean(),
  })
  .strict();
export interface ProductionDatabaseInspection {
  clusterId: string;
  database: string;
  setupRole: string;
  serverVersion: number;
}
/** A management role must establish immutable cluster identity; a successful login alone is insufficient. */
export async function inspectProductionDatabase(
  database: PostgresJsDatabase,
  expectedDatabase: string,
  controlClusterId: string,
): Promise<ProductionDatabaseInspection> {
  try {
    if (!/^[0-9]{1,20}$/.test(controlClusterId))
      throw new Error("Missing control identity");
    const row = await database.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const rows = await tx.execute(sql`select
        (select system_identifier::text from pg_catalog.pg_control_system()) as cluster_id,
        pg_catalog.current_database() as database_name,
        current_user::text as role_name,
        pg_catalog.current_setting('server_version_num')::integer as server_version,
        pg_catalog.pg_is_in_recovery() as replica,
        r.rolcreaterole as create_role,
        r.rolcreatedb as create_database
        from pg_catalog.pg_roles r where r.rolname = current_user`);
      if (rows.length !== 1) throw new Error("Missing identity");
      return Metadata.parse(rows[0]);
    });
    if (
      row.cluster_id === controlClusterId ||
      row.database_name !== expectedDatabase ||
      row.replica ||
      !row.create_role ||
      !row.create_database
    )
      throw new Error("Unsafe setup target");
    return {
      clusterId: row.cluster_id,
      database: row.database_name,
      setupRole: row.role_name,
      serverVersion: row.server_version,
    };
  } catch {
    throw new Error(
      "Production database identity and setup privileges could not be verified.",
    );
  }
}
