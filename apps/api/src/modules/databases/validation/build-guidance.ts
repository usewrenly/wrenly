/** Safe framework instructions derived from an admitted selection; never from live rows or credentials. */
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { BuildExecutionInterruptedError } from "../../builds/execution/build-interruption";

/** No selection means no database instructions; provisioning is always a separate owner action. */
export function databaseBuildGuidance(
  framework: string,
  value: unknown,
): string {
  if (value === undefined) return "";
  if (
    !BuildDatabaseSelection.safeParse(value).success ||
    !["nextjs", "laravel"].includes(framework)
  )
    throw new BuildExecutionInterruptedError();
  const connection =
    framework === "laravel"
      ? "Use Laravel's pgsql connection and DB_HOST, DB_PORT, DB_DATABASE, DB_USERNAME and DB_PASSWORD environment variables. Keep its configuration environment-based."
      : "Use Drizzle with Postgres.js. Use exactly const client = postgres(); export const db = drizzle(client, { schema });. postgres() reads PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD supplied only at runtime. Wrenly does not provide DATABASE_URL or POSTGRES_URL; never read them or supply fallback connection URLs, hosts or credentials. All server pages in this managed app must export const dynamic = 'force-dynamic' (or export const revalidate = 0), or put the force-dynamic export in the root layout. Never await database queries during static page generation. Browser-only pages still need safe API error handling.";
  const migrations =
    framework === "laravel"
      ? "Declare adapter laravel and every native database/migrations/*.php migration path. Preserve existing migrations; changes require new reviewed migrations."
      : "Declare adapter drizzle-postgres and every drizzle/*.sql migration path. Supply a matching drizzle/meta/_journal.json with ordered unique tags/timestamps. Preserve applied migration files and add changes as new migrations.";
  return [
    "A managed Development PostgreSQL resource was explicitly selected for this build. No database data or connection secrets are available to the model.",
    'Include wrenly.app.json with version 1 and database { engine: "postgresql", adapter, migrations: [saved relative paths] }. No endpoint, password, command or executable hook belongs in this manifest.',
    framework === "nextjs"
      ? [
          'Example wrenly.app.json: {"version":1,"database":{"engine":"postgresql","adapter":"drizzle-postgres","migrations":["drizzle/0000_initial.sql"]}}',
          'Matching drizzle/meta/_journal.json: {"version":"7","dialect":"postgresql","entries":[{"idx":0,"version":"7","when":1,"tag":"0000_initial","breakpoints":true}]}',
          "Each journal tag is the migration filename WITHOUT .sql and WITHOUT drizzle/. Entry idx starts at 0; timestamps must be strictly increasing safe integers; breakpoints must be a boolean. The manifest list must include every saved SQL migration exactly once. Keep existing journal entries unchanged when adding a migration.",
        ].join("\n")
      : "",
    connection,
    migrations,
    "For every browser fetch, check response.ok before reading successful data and validate its shape (for list responses, Array.isArray). Show a visible, retryable error state on API failure. Never put an error object into array state or hide a failed database request as an empty list.",
    "Package installation and compilation have no database access. Validation uses a separate empty disposable database. Applying migrations to existing Development data requires owner review; generated code must not run migrations or seed destructive data at application startup.",
    "Never hardcode connection values, use TCP fallback, open external database connections or request additional network permissions. Use only the supplied runtime role and Unix socket.",
  ].join("\n");
}
