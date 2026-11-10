/** Fixed trusted DDL for the app-only cluster. Each exported phase needs a separate durable caller intent. */
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  validateProductionProjectCredentials,
  type ProductionClusterIdentity,
} from "./contract";
const CLUSTER_ID = /^[0-9]{1,20}$/;
/** Rejects a control-cluster alias even when the database or hostname differs. */
export async function verifyProductionClusterAuthority(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
): Promise<void> {
  if (
    !CLUSTER_ID.test(identity.appClusterId) ||
    !CLUSTER_ID.test(identity.controlClusterId) ||
    identity.appClusterId === identity.controlClusterId
  )
    throw new Error("Invalid Production cluster identity.");
  const rows =
    await database.execute(sql`select (select system_identifier::text from pg_catalog.pg_control_system()) as cluster_id,
    (select rolsuper from pg_catalog.pg_roles where rolname=current_user) as administrator,
    pg_catalog.pg_is_in_recovery() as replica`);
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.cluster_id !== identity.appClusterId ||
    row?.administrator !== true ||
    row?.replica !== false
  )
    throw new Error("Production cluster authority changed.");
}
/** Creates only this project's restricted roles, atomically; never changes existing role passwords. */
export async function createProductionProjectRoles(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  input: unknown,
): Promise<void> {
  const credentials = validateProductionProjectCredentials(resourceId, input);
  try {
    await database.transaction(async (tx) => {
      await verifyProductionClusterAuthority(tx, identity);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      await tx.execute(
        sql`select pg_catalog.set_config('search_path','pg_catalog',true)`,
      );
      await tx.execute(
        sql`select pg_catalog.set_config('wrenly.production_roles',${JSON.stringify(credentials)},true)`,
      );
      await tx.execute(sql`do $$
        declare cfg jsonb := pg_catalog.current_setting('wrenly.production_roles')::jsonb; item jsonb;
        begin
          if not pg_catalog.pg_try_advisory_xact_lock(19872026, 2) then raise exception 'Production provisioning active'; end if;
          if exists(select 1 from pg_catalog.pg_database where datname=cfg->>'database') then raise exception 'Database exists'; end if;
          for item in select value from pg_catalog.jsonb_each(cfg) where key in ('migrator','runtime','reader') loop
            if exists(select 1 from pg_catalog.pg_roles where rolname=item->>'user') then raise exception 'Role exists'; end if;
          end loop;
          for item in select value from pg_catalog.jsonb_each(cfg) where key in ('migrator','runtime','reader') loop
            execute pg_catalog.format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 8 PASSWORD %L',item->>'user',item->>'password');
          end loop;
        end $$`);
    });
  } catch {
    throw new Error(
      "Production role creation could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}
/** CREATE DATABASE has its own saved phase because PostgreSQL cannot execute it inside a transaction. */
export async function createProductionProjectDatabase(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  input: unknown,
): Promise<void> {
  const credentials = validateProductionProjectCredentials(resourceId, input);
  try {
    await verifyProductionClusterAuthority(database, identity);
    const rows = await database.execute(
      sql`select rolname from pg_catalog.pg_roles where rolname in (${credentials.migrator.user},${credentials.runtime.user},${credentials.reader.user}) and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolinherit and rolconnlimit=8`,
    );
    if (rows.length !== 3) throw new Error("Project roles unavailable");
    await database.execute(
      sql`create database ${sql.identifier(credentials.database)} owner ${sql.identifier(credentials.migrator.user)} template template0 allow_connections false`,
    );
  } catch {
    throw new Error(
      "Production database creation could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}
/** Enables this database only after removing PUBLIC access and granting its three project roles. */
export async function enableProductionProjectConnections(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  input: unknown,
): Promise<void> {
  const credentials = validateProductionProjectCredentials(resourceId, input);
  try {
    await database.transaction(async (tx) => {
      await verifyProductionClusterAuthority(tx, identity);
      const rows = await tx.execute(
        sql`select r.rolname as owner, d.datallowconn as connected from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname=${credentials.database}`,
      );
      if (
        rows.length !== 1 ||
        rows[0]?.owner !== credentials.migrator.user ||
        rows[0]?.connected !== false
      )
        throw new Error("Database state changed");
      await tx.execute(
        sql`revoke all privileges on database ${sql.identifier(credentials.database)} from public`,
      );
      await tx.execute(
        sql`grant connect on database ${sql.identifier(credentials.database)} to ${sql.identifier(credentials.migrator.user)},${sql.identifier(credentials.runtime.user)},${sql.identifier(credentials.reader.user)}`,
      );
      await tx.execute(
        sql`alter database ${sql.identifier(credentials.database)} allow_connections true`,
      );
    });
  } catch {
    throw new Error(
      "Production database connection grants could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}
/** Runs through a privileged connection to the new project database, never the control or maintenance database. */
export async function initializeProductionProjectSchema(
  database: PostgresJsDatabase,
  identity: ProductionClusterIdentity,
  resourceId: string,
  input: unknown,
): Promise<void> {
  const credentials = validateProductionProjectCredentials(resourceId, input);
  try {
    await database.transaction(async (tx) => {
      await verifyProductionClusterAuthority(tx, identity);
      const rows =
        await tx.execute(sql`select current_database() as database_name,
        (select r.rolname from pg_catalog.pg_database d join pg_catalog.pg_roles r on r.oid=d.datdba where d.datname=current_database()) as owner`);
      if (
        rows.length !== 1 ||
        rows[0]?.database_name !== credentials.database ||
        rows[0]?.owner !== credentials.migrator.user
      )
        throw new Error("Wrong project database");
      await tx.execute(
        sql`select pg_catalog.set_config('wrenly.production_roles',${JSON.stringify({ migrator: credentials.migrator.user, runtime: credentials.runtime.user, reader: credentials.reader.user })},true)`,
      );
      await tx.execute(sql`do $$
        declare cfg jsonb := pg_catalog.current_setting('wrenly.production_roles')::jsonb; m text := cfg->>'migrator'; r text := cfg->>'runtime'; v text := cfg->>'reader';
        begin
          if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','f','S')) or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public') then raise exception 'Existing schema requires review'; end if;
          execute pg_catalog.format('ALTER SCHEMA public OWNER TO %I',m);
          execute pg_catalog.format('REVOKE ALL ON SCHEMA public FROM PUBLIC,%I,%I',r,v);
          execute pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I,%I',r,v);
          execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO %I',m,r);
          execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',m,v);
          execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO %I',m,r);
          execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I',m,v);
          execute pg_catalog.format('ALTER ROLE %I IN DATABASE %I SET default_transaction_read_only = on',v,current_database());
          execute pg_catalog.format('ALTER ROLE %I IN DATABASE %I SET statement_timeout = %L',v,current_database(),'5s');
          execute pg_catalog.format('ALTER ROLE %I IN DATABASE %I SET lock_timeout = %L',v,current_database(),'1s');
        end $$`);
    });
  } catch {
    throw new Error(
      "Production schema setup could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}
