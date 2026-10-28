// Produces a bounded read-only projection of permitted application base tables.
// Uses fixed built-in type handling and escaped identifiers, never caller SQL or arbitrary casts.
import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  DATABASE_VIEW_LIMITS,
  type DatabaseViewerResult,
} from "./viewer-contract";
export type {
  DatabaseViewerResult,
  DatabaseViewerColumn,
} from "./viewer-contract";
const {
  maxTables: MAX_TABLES,
  maxColumns: MAX_COLUMNS,
  maxRows: MAX_ROWS,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxCursorBytes: MAX_CURSOR_BYTES,
} = DATABASE_VIEW_LIMITS;
const JOURNALS = ["migrations", "__drizzle_migrations"];
const SUPPORTED_TYPES = new Set([
  16, 17, 20, 21, 23, 25, 700, 701, 1042, 1043, 1082, 1083, 1114, 1184, 1186,
  1700, 2950, 114, 3802,
]);
const KEY_TYPES: Readonly<Record<number, string>> = {
  20: "int8",
  21: "int2",
  23: "int4",
  2950: "uuid",
  1043: "varchar",
};
function identifier(name: string): SQL {
  return sql`${sql.identifier(name)}`;
}
/** Only the fixed base-table projection is available: callers cannot supply SQL or type casts. */
export async function readAppDatabaseView(
  database: PostgresJsDatabase,
  input: { table?: string; rows: boolean; after?: string },
): Promise<DatabaseViewerResult> {
  if (
    (input.table !== undefined &&
      (!input.table ||
        Buffer.byteLength(input.table) > 63 ||
        input.table.includes("\0"))) ||
    (input.after !== undefined &&
      Buffer.byteLength(input.after) > MAX_CURSOR_BYTES)
  )
    throw new Error("Invalid bounded table/cursor");
  return database.transaction(
    async (tx) => {
      await tx.execute(sql`set local statement_timeout = '2000ms'`);
      await tx.execute(sql`set local lock_timeout = '1000ms'`);
      await tx.execute(sql`set local search_path = pg_catalog`);
      const available = await tx.execute(
        sql`select c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relname not in ('migrations','__drizzle_migrations') and pg_catalog.has_table_privilege(current_user,c.oid,'SELECT') order by c.relname limit ${MAX_TABLES + 1}`,
      );
      if (available.length > MAX_TABLES)
        throw new Error("Table catalog exceeds viewer bounds");
      const tables = available.map((row) => String(row.relname));
      const result: DatabaseViewerResult = {
        tables,
        table: input.table ?? null,
        columns: [],
        rows: [],
        sample: false,
        nextKey: null,
        truncatedColumns: false,
      };
      if (!input.table) return result;
      if (!tables.includes(input.table) || JOURNALS.includes(input.table))
        throw new Error("Application table is not available");
      const columns =
        await tx.execute(sql`select a.attname,t.typname,t.oid as type_oid,tn.nspname as type_namespace,a.attnotnull,a.atttypmod,
      exists(select 1 from pg_catalog.pg_index i cross join lateral pg_catalog.unnest(i.indkey) with ordinality as k(attnum,position)
        where i.indrelid=c.oid and i.indisprimary and k.position<=i.indnkeyatts and k.attnum=a.attnum) as primary_key,
      exists(select 1 from pg_catalog.pg_index i where i.indrelid=c.oid and i.indisprimary and i.indnkeyatts=1 and i.indkey[0]=a.attnum) as pagination_key
      from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace join pg_catalog.pg_attribute a on a.attrelid=c.oid
      join pg_catalog.pg_type t on t.oid=a.atttypid join pg_catalog.pg_namespace tn on tn.oid=t.typnamespace
      where n.nspname='public' and c.relname=${input.table} and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped order by a.attnum limit ${MAX_COLUMNS + 1}`);
      result.truncatedColumns = columns.length > MAX_COLUMNS;
      const selected = columns.slice(0, MAX_COLUMNS);
      result.columns = selected.map((row) => ({
        name: String(row.attname),
        type: String(row.typname),
        nullable: row.attnotnull !== true,
        primary: row.primary_key === true,
        supported:
          row.type_namespace === "pg_catalog" &&
          SUPPORTED_TYPES.has(Number(row.type_oid)),
      }));
      if (!input.rows) return result;
      const keyIndex = selected.findIndex(
        (row) =>
          row.pagination_key === true &&
          row.type_namespace === "pg_catalog" &&
          Boolean(KEY_TYPES[Number(row.type_oid)]) &&
          (Number(row.type_oid) !== 1043 ||
            (Number(row.atttypmod) >= 4 && Number(row.atttypmod) <= 260)),
      );
      const key = keyIndex >= 0 ? selected[keyIndex] : undefined;
      result.sample = !key;
      if (input.after !== undefined && !key)
        throw new Error("This table supports a bounded sample only");
      const projection = selected.map((column, index) => {
        const columnName = identifier(String(column.attname)),
          meta = result.columns[index];
        const value = !meta?.supported
          ? sql`'[unsupported type]'::text`
          : Number(column.type_oid) === 17
            ? sql`pg_catalog.encode(pg_catalog.substring(${columnName},1,128),'hex')`
            : sql`pg_catalog.left(${columnName}::text,128)`;
        return sql`${value} as ${sql.identifier(`cell_${index}`)}`;
      });
      if (key)
        projection.push(
          sql`${identifier(String(key.attname))}::text as key_value`,
        );
      if (!projection.length) return result;
      const after =
        input.after === undefined
          ? sql``
          : sql`where ${identifier(String(key?.attname))} > ${input.after}::pg_catalog.${sql.identifier(KEY_TYPES[Number(key?.type_oid)] ?? "text")}`;
      const order = key
        ? sql`order by ${identifier(String(key.attname))}`
        : sql``;
      const values = await tx.execute(
        sql`select ${sql.join(projection, sql`, `)} from public.${identifier(input.table)} ${after} ${order} limit ${MAX_ROWS + 1}`,
      );
      let lastKey: string | null = null;
      for (const row of values.slice(0, MAX_ROWS)) {
        const cells = selected.map((_column, index) =>
          row[`cell_${index}`] === null ? null : String(row[`cell_${index}`]),
        );
        result.rows.push(cells);
        if (
          Buffer.byteLength(JSON.stringify(result)) >
          MAX_RESPONSE_BYTES - 2048
        ) {
          result.rows.pop();
          break;
        }
        if (key && typeof row.key_value === "string") lastKey = row.key_value;
      }
      if (key && values.length > result.rows.length && lastKey !== null)
        result.nextKey = lastKey;
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES)
        throw new Error("Viewer response exceeds bounds");
      return result;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
