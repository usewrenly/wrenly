// Fixed trusted PostgreSQL role provisioning and privilege enforcement for one app resource.
// Identifiers/credentials are resource-bound before effects; this never opens the control client.
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { AppDatabaseSessionTarget } from "./runtime-contract";

const RESOURCE_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PASSWORD = /^[a-f0-9]{64}$/;
export const APP_DATABASE_ROLE_POLICY_VERSION = 1;
export interface AppDatabaseRole {
  user: string;
  password: string;
}
export interface AppDatabaseCredentials {
  version: 1;
  database: "app";
  administrator: AppDatabaseRole;
  migrator: AppDatabaseRole;
  runtime: AppDatabaseRole;
  reader: AppDatabaseRole;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Binds every credential to the resource and role before any connection or SQL can occur. */
export function validateAppDatabaseCredentials(
  resourceId: string,
  input: unknown,
): AppDatabaseCredentials {
  if (
    !RESOURCE_ID.test(resourceId) ||
    !record(input) ||
    input.version !== 1 ||
    input.database !== "app" ||
    !Object.hasOwn(input, "version") ||
    !Object.hasOwn(input, "database") ||
    Object.keys(input).length !== 6
  )
    throw new Error("Invalid application database credentials.");
  const roles = ["administrator", "migrator", "runtime", "reader"] as const;
  const suffixes = {
    administrator: "admin",
    migrator: "migrate",
    runtime: "runtime",
    reader: "reader",
  };
  const passwords = new Set<string>();
  for (const role of roles) {
    const value = input[role];
    if (
      !Object.hasOwn(input, role) ||
      !record(value) ||
      Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "user") ||
      !Object.hasOwn(value, "password") ||
      value.user !==
        `wrenly_${resourceId.replaceAll("-", "")}_${suffixes[role]}` ||
      typeof value.password !== "string" ||
      !PASSWORD.test(value.password) ||
      passwords.has(value.password)
    )
      throw new Error(
        "Application database roles must have distinct resource-bound credentials.",
      );
    passwords.add(value.password);
  }
  return input as unknown as AppDatabaseCredentials;
}

/** Creates the initial roles once. Existing roles/schema require explicit inspection, never automatic adoption. */
export async function provisionAppDatabaseRoles(
  database: PostgresJsDatabase,
  resourceId: string,
  input: unknown,
): Promise<void> {
  const credentials = validateAppDatabaseCredentials(resourceId, input);
  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_catalog.set_config('search_path', 'pg_catalog', true)`,
      );
      await transaction.execute(
        sql`select pg_catalog.set_config('wrenly.database_provisioning', ${JSON.stringify(credentials)}, true)`,
      );
      // PostgreSQL role DDL cannot bind identifiers/passwords directly. Fixed server-side
      // format(%I, %L) keeps this approved exception separate from model/browser SQL.
      await transaction.execute(sql`do $$
        declare cfg jsonb := current_setting('wrenly.database_provisioning')::jsonb;
                item jsonb; role_name text;
        begin
          if current_database() <> 'app' or current_user <> cfg->'administrator'->>'user'
             or not exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper)
          then raise exception 'Wrong application database administrator'; end if;
          if not pg_catalog.pg_try_advisory_xact_lock(19872026, 1) then raise exception 'Provisioning already active'; end if;
          if exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
                    where n.nspname='public' and c.relkind in ('r','p','v','m','f','S'))
             or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public')
          then raise exception 'Existing application schema requires review'; end if;
          for item in select value from jsonb_each(cfg) where key in ('migrator','runtime','reader') loop
            role_name := item->>'user';
            if exists(select 1 from pg_catalog.pg_roles where rolname=role_name)
            then raise exception 'Existing application role requires reconciliation'; end if;
            execute format('create role %I with login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit connection limit 8 password %L', role_name, item->>'password');
          end loop;
          execute 'revoke all on database app from public';
          execute 'revoke connect, temporary on database postgres from public';
          execute 'revoke connect, temporary on database template1 from public';
          execute 'revoke connect, temporary on database template0 from public';
          execute 'revoke all on schema public from public';
          execute format('alter schema public owner to %I', cfg->'migrator'->>'user');
          for item in select value from jsonb_each(cfg) where key in ('migrator','runtime','reader') loop
            execute format('grant connect on database app to %I', item->>'user');
          end loop;
          execute format('grant usage on schema public to %I, %I', cfg->'runtime'->>'user', cfg->'reader'->>'user');
          execute format('alter default privileges for role %I in schema public grant select, insert, update, delete on tables to %I', cfg->'migrator'->>'user', cfg->'runtime'->>'user');
          execute format('alter default privileges for role %I in schema public grant usage, select on sequences to %I', cfg->'migrator'->>'user', cfg->'runtime'->>'user');
          execute format('alter default privileges for role %I in schema public grant select on tables to %I', cfg->'migrator'->>'user', cfg->'reader'->>'user');
          execute format('alter role %I in database app set statement_timeout = %L', cfg->'reader'->>'user', '2s');
          execute format('alter role %I in database app set lock_timeout = %L', cfg->'reader'->>'user', '1s');
          execute format('alter role %I in database app set idle_in_transaction_session_timeout = %L', cfg->'reader'->>'user', '5s');
          execute format('alter role %I in database app set default_transaction_read_only = on', cfg->'reader'->>'user');
        end $$`);
    });
  } catch {
    throw new Error(
      "Application database role provisioning was not confirmed. Reconcile the existing roles before retrying.",
    );
  }
}

/** Restores fixed app permissions after reviewed DDL; journals never become application-writable. */
export async function enforceAppDatabaseRolePolicy(
  database: PostgresJsDatabase,
  resourceId: string,
  input: unknown,
): Promise<void> {
  const credentials = validateAppDatabaseCredentials(resourceId, input);
  await database.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_catalog.set_config('search_path','pg_catalog',true)`,
    );
    await tx.execute(
      sql`select pg_catalog.set_config('wrenly.database_policy',${JSON.stringify({ administrator: credentials.administrator.user, migrator: credentials.migrator.user, runtime: credentials.runtime.user, reader: credentials.reader.user })},true)`,
    );
    await tx.execute(sql`do $$
      declare p jsonb := pg_catalog.current_setting('wrenly.database_policy')::jsonb; m text := p->>'migrator'; r text := p->>'runtime'; v text := p->>'reader'; journal text; sequence_name text;
      begin
        if current_database() <> 'app' or current_user <> p->>'administrator' then raise exception 'Invalid resource administrator'; end if;
        if not exists(select 1 from pg_catalog.pg_namespace n join pg_catalog.pg_roles x on x.oid=n.nspowner where n.nspname='public' and x.rolname=m) then raise exception 'Application schema ownership changed'; end if;
        if (select count(*) from pg_catalog.pg_roles where rolname in (m,r,v) and rolcanlogin and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolinherit and rolconnlimit=8) <> 3 then raise exception 'Application role flags changed'; end if;
        if exists(select 1 from pg_catalog.pg_proc f join pg_catalog.pg_namespace n on n.oid=f.pronamespace where n.nspname='public' and f.prosecdef) or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('v','f')) then raise exception 'Owner-executed database objects are not supported'; end if;
        execute pg_catalog.format('REVOKE ALL ON SCHEMA public FROM PUBLIC,%I,%I',r,v);
        execute pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I,%I',r,v);
        execute pg_catalog.format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC,%I,%I',r,v);
        execute pg_catalog.format('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO %I',r);
        execute pg_catalog.format('GRANT SELECT ON ALL TABLES IN SCHEMA public TO %I',v);
        execute pg_catalog.format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC,%I,%I',r,v);
        execute pg_catalog.format('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',r);
        execute pg_catalog.format('GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',v);
        execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC,%I,%I',m,r,v);
        execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO %I',m,r);
        execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO %I',m,v);
        execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC,%I,%I',m,r,v);
        execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO %I',m,r);
        execute pg_catalog.format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON SEQUENCES TO %I',m,v);
        foreach journal in array array['migrations','__drizzle_migrations'] loop
          if pg_catalog.to_regclass(pg_catalog.format('public.%I',journal)) is not null then
            execute pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,%I,%I',journal,r,v);
            sequence_name := pg_catalog.pg_get_serial_sequence(pg_catalog.format('public.%I',journal),'id');
            if sequence_name is not null then execute pg_catalog.format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,%I,%I',sequence_name,r,v); end if;
          end if;
        end loop;
      end $$`);
  });
}

/** Confirms quiescence of one platform role after its operation client/broker has stopped. */
export async function terminateAppDatabaseSessions(
  database: PostgresJsDatabase,
  resourceId: string,
  input: unknown,
  target: AppDatabaseSessionTarget,
): Promise<void> {
  if (target !== "reader" && target !== "migrator" && target !== "runtime")
    throw new Error("Invalid resource session target");
  const credentials = validateAppDatabaseCredentials(resourceId, input);
  const role = credentials[target].user;
  await database.transaction(async (tx) => {
    const authority = await tx.execute(sql`select current_database() = 'app'
      and current_user = ${credentials.administrator.user}
      and exists(select 1 from pg_catalog.pg_roles where rolname=current_user and rolsuper)
      and exists(select 1 from pg_catalog.pg_roles where rolname=${role}
        and not rolsuper and not rolcreatedb and not rolcreaterole
        and not rolreplication and not rolbypassrls) as allowed`);
    if (authority[0]?.allowed !== true)
      throw new Error("Resource session authority changed");
    const terminated =
      await tx.execute(sql`select pg_catalog.pg_terminate_backend(pid, 1000) as stopped
      from pg_catalog.pg_stat_activity where datname='app' and usename=${role}
        and pid <> pg_catalog.pg_backend_pid()`);
    if (terminated.some((row) => row.stopped !== true))
      throw new Error("Resource sessions did not terminate");
    // pg_stat_clear_snapshot prevents the confirmation from reusing the pre-termination snapshot.
    await tx.execute(sql`select pg_catalog.pg_stat_clear_snapshot()`);
    const remaining =
      await tx.execute(sql`select exists(select 1 from pg_catalog.pg_stat_activity
      where datname='app' and usename=${role} and pid <> pg_catalog.pg_backend_pid()) as active`);
    if (remaining[0]?.active !== false)
      throw new Error("Resource sessions remain active");
  });
}
