/**
 * COMPONENT: Application database connection settings
 * PURPOSE: Give an isolated application only its runtime role and local socket.
 * INPUTS: Framework, disposable/saved resource identity and decrypted runtime role.
 * OUTPUTS: Process-local settings, never Docker Env, source files or a database URL.
 * STEPS: Check exact role ownership, select fixed framework keys and freeze the result.
 * EDGE CASES: A migrator/reader/admin role or unsupported framework is refused.
 * ERROR STATES: Invalid input produces a fixed message without credential contents.
 */
import { DATABASE_SOCKET_DIRECTORY, DATABASE_SOCKET_PORT } from "../database-resource-policy";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PASSWORD = /^[a-f0-9]{64}$/;

/**
 * Call inside the trusted container bootstrap after receiving credentials on stdin.
 * The caller must verify socket ownership and keep these settings out of logs/images.
 * This formatter neither opens a connection nor grants database access.
 */
export function applicationDatabaseEnvironment(
  framework: "nextjs" | "laravel",
  resourceId: string,
  role: { user: string; password: string },
): Readonly<Record<string, string>> {
  if (!UUID.test(resourceId) || !role || typeof role.user !== "string" ||
      typeof role.password !== "string" || !PASSWORD.test(role.password) ||
      role.user !== `wrenly_${resourceId.replaceAll("-", "")}_runtime`) {
    throw new Error("Application database settings require the matching runtime role.");
  }
  if (framework === "nextjs") {
    // Postgres.js reads these standard PostgreSQL variables with postgres(). Its
    // URL parser does not use a host query parameter to select a Unix socket.
    return Object.freeze({
      PGHOST: DATABASE_SOCKET_DIRECTORY, PGPORT: String(DATABASE_SOCKET_PORT),
      PGDATABASE: "app", PGUSER: role.user, PGPASSWORD: role.password,
    });
  }
  if (framework === "laravel") {
    return Object.freeze({
      DB_CONNECTION: "pgsql", DB_HOST: DATABASE_SOCKET_DIRECTORY,
      DB_PORT: String(DATABASE_SOCKET_PORT), DB_DATABASE: "app",
      DB_USERNAME: role.user, DB_PASSWORD: role.password,
    });
  }
  throw new Error("Application database settings require a supported framework.");
}
