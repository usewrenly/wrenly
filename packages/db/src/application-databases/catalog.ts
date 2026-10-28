// Reads bounded schema/journal metadata on the supplied application connection.
// Fixed catalog queries inspect structure, never application rows or model-supplied SQL.
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createHash } from "node:crypto";
const MAX_SCHEMA_BYTES = 1024 * 1024;
/** Canonical public-schema and supported migration-journal identity; never includes application rows. */
export async function inspectAppDatabaseSchema(
  database: PostgresJsDatabase,
): Promise<string> {
  return database.transaction(
    async (tx) => {
      await tx.execute(sql`set local statement_timeout = '2000ms'`);
      await tx.execute(sql`set local lock_timeout = '1000ms'`);
      await tx.execute(sql`set local search_path = pg_catalog`);
      const columns =
        await tx.execute(sql`select c.relname as table_name, c.relkind, a.attname as column_name, a.attnum, pg_catalog.format_type(a.atttypid,a.atttypmod) as type, a.attnotnull, pg_catalog.pg_get_expr(d.adbin,d.adrelid) as default_expression, a.attidentity, a.attgenerated
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      join pg_catalog.pg_attribute a on a.attrelid=c.oid
      left join pg_catalog.pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname='public' and c.relkind in ('r','p','v','m','f') and a.attnum>0 and not a.attisdropped
      order by c.relname,a.attnum limit 4097`);
      const constraints =
        await tx.execute(sql`select c.relname as table_name, x.conname, pg_catalog.pg_get_constraintdef(x.oid) as definition
      from pg_catalog.pg_constraint x join pg_catalog.pg_class c on c.oid=x.conrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' order by c.relname,x.conname limit 4097`);
      const indexes =
        await tx.execute(sql`select c.relname as table_name, i.relname as index_name, pg_catalog.pg_get_indexdef(i.oid) as definition
      from pg_catalog.pg_index x join pg_catalog.pg_class c on c.oid=x.indrelid join pg_catalog.pg_class i on i.oid=x.indexrelid
      join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,i.relname limit 4097`);
      const functions =
        await tx.execute(sql`select p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid) as arguments, pg_catalog.pg_get_functiondef(p.oid) as definition
      from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p') order by p.proname,arguments limit 4097`);
      const enums = await tx.execute(
        sql`select t.typname,e.enumsortorder,e.enumlabel from pg_catalog.pg_enum e join pg_catalog.pg_type t on t.oid=e.enumtypid join pg_catalog.pg_namespace n on n.oid=t.typnamespace where n.nspname='public' order by t.typname,e.enumsortorder limit 4097`,
      );
      const policies =
        await tx.execute(sql`select c.relname,p.polname,p.polcmd,p.polpermissive,pg_catalog.pg_get_expr(p.polqual,p.polrelid) as using_expression,pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) as check_expression
      from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid=p.polrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname,p.polname limit 4097`);
      const relations = await tx.execute(
        sql`select c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,case when c.relkind in ('v','m') then pg_catalog.pg_get_viewdef(c.oid,true) else null end as view_definition from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m') order by c.relname limit 4097`,
      );
      const triggers = await tx.execute(
        sql`select c.relname,t.tgname,pg_catalog.pg_get_triggerdef(t.oid) as definition from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname limit 4097`,
      );
      const sequences = await tx.execute(
        sql`select c.relname,s.seqtypid::pg_catalog.regtype::text as type,s.seqstart::text,s.seqincrement::text,s.seqmax::text,s.seqmin::text,s.seqcache::text,s.seqcycle from pg_catalog.pg_sequence s join pg_catalog.pg_class c on c.oid=s.seqrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' order by c.relname limit 4097`,
      );
      const journals: Record<string, unknown> = {};
      const [journal] = await tx.execute(
        sql`select pg_catalog.to_regclass('public.migrations')::text as laravel, pg_catalog.to_regclass('public.__drizzle_migrations')::text as drizzle`,
      );
      if (journal?.laravel)
        journals.laravel = await tx.execute(
          sql`select migration,batch from public.migrations order by id limit 1025`,
        );
      if (journal?.drizzle)
        journals.drizzle = await tx.execute(
          sql`select hash,created_at::text from public.__drizzle_migrations order by id limit 1025`,
        );
      if (
        [
          columns,
          constraints,
          indexes,
          functions,
          enums,
          policies,
          relations,
          triggers,
          sequences,
        ].some((rows) => rows.length > 4096)
      )
        throw new Error("Schema inspection exceeds its bounds");
      const serialized = JSON.stringify({
        columns: [...columns],
        constraints: [...constraints],
        indexes: [...indexes],
        functions: [...functions],
        enums: [...enums],
        policies: [...policies],
        relations: [...relations],
        triggers: [...triggers],
        sequences: [...sequences],
        journals,
      });
      if (
        Buffer.byteLength(serialized) > MAX_SCHEMA_BYTES ||
        Object.values(journals).some(
          (value) => Array.isArray(value) && value.length > 1024,
        )
      )
        throw new Error("Schema/journal inspection exceeds its bounds");
      return createHash("sha256").update(serialized).digest("hex");
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
