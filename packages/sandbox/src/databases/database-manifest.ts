// Validates saved database declarations and migration-file identities as data.
// Source never chooses provisioning commands or credentials; no resources start on import.
// COMPONENT: Revision-bound migration identity
// PURPOSE: Bind reviewed migrations to the bytes their framework can execute.
// INPUTS: Saved file paths/content and framework; OUTPUTS: manifest/hashes/digest or refusal.
// STEPS: Validate bounds/paths/declaration, hash migrations and journal, then bind all
// Laravel source because Artisan boots application code. Sort identities before hashing.
// EDGE CASES: No manifest remains stateless; source ordering does not change identity.
// ERROR STATES: Missing/undeclared/oversized files or wrong adapter fail before execution.
import { managedDatabaseRenderingProblem, managedPostgresConnectionProblem } from "../source-policy/managed-postgres-source";
import { createHash } from "node:crypto";
import { validateFilePaths } from "../source-policy/file-paths";

const MANIFEST_PATH = "wrenly.app.json";
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_MIGRATIONS = 128;
const MAX_MIGRATION_BYTES = 512 * 1024;
const MAX_PATH_BYTES = 256;
const MAX_SOURCE_FILES = 1000;
const MAX_LARAVEL_SOURCE_BYTES = 2 * 1024 * 1024;
const DRIZZLE_JOURNAL_PATH = "drizzle/meta/_journal.json";
export interface AppDatabaseManifest {
  version: 1;
  database: {
    engine: "postgresql";
    adapter: "drizzle-postgres" | "laravel";
    migrations: string[];
  };
}
export interface AppDatabaseMigrationSet {
  manifest: AppDatabaseManifest;
  files: Array<{ path: string; sha256: string }>;
  digest: string;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** Fixed validation messages are safe to return as repair guidance; arbitrary exceptions are not. */
export class AppDatabaseManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppDatabaseManifestError";
  }
}

/** Reads bounded declarations and hashes exact saved migration bytes without executing generated source. */
export function readAppDatabaseManifest(
  files: Array<{ path: string; content: string }>,
  stack: string,
): AppDatabaseMigrationSet | null {
  if (files.length > MAX_SOURCE_FILES)
    throw new AppDatabaseManifestError(
      "Application source exceeds its file count limit.",
    );
  validateFilePaths(files);
  const manifestFile = files.find((file) => file.path === MANIFEST_PATH);
  if (!manifestFile) return null;
  if (Buffer.byteLength(manifestFile.content) > MAX_MANIFEST_BYTES)
    throw new AppDatabaseManifestError(
      "Application database manifest exceeds its size limit.",
    );
  let value: unknown;
  try {
    value = JSON.parse(manifestFile.content);
  } catch {
    throw new AppDatabaseManifestError(
      "Application database manifest must contain valid JSON.",
    );
  }
  if (
    !object(value) ||
    !exactKeys(value, ["version", "database"]) ||
    value.version !== 1 ||
    !object(value.database) ||
    !exactKeys(value.database, ["engine", "adapter", "migrations"]) ||
    value.database.engine !== "postgresql"
  )
    throw new AppDatabaseManifestError(
      "Application database manifest must declare version 1 and PostgreSQL without endpoints, credentials or commands.",
    );
  const declaration = value.database;
  const adapter = declaration.adapter;
  if (
    stack === "nextjs"
      ? adapter !== "drizzle-postgres"
      : stack === "laravel"
        ? adapter !== "laravel"
        : true
  )
    throw new AppDatabaseManifestError(
      "Application database adapter does not match a supported project framework.",
    );
  if (
    !Array.isArray(declaration.migrations) ||
    declaration.migrations.length < 1 ||
    declaration.migrations.length > MAX_MIGRATIONS
  )
    throw new AppDatabaseManifestError(
      "Declare a bounded nonempty migration file list.",
    );
  const paths: string[] = [];
  let bytes = 0;
  const migrationFiles: AppDatabaseMigrationSet["files"] = [];
  for (const path of declaration.migrations as unknown[]) {
    const pattern =
      adapter === "laravel"
        ? /^database\/migrations\/[a-zA-Z0-9_-]+\.php$/
        : /^drizzle\/[a-zA-Z0-9_-]+\.sql$/;
    if (
      typeof path !== "string" ||
      Buffer.byteLength(path) > MAX_PATH_BYTES ||
      !pattern.test(path) ||
      paths.includes(path)
    )
      throw new AppDatabaseManifestError(
        "Migration paths must be unique framework migration files without traversal or generated commands.",
      );
    const file = files.find((entry) => entry.path === path);
    if (!file || !file.content.trim())
      throw new AppDatabaseManifestError(
        "A declared database migration is missing or empty in this revision.",
      );
    bytes += Buffer.byteLength(file.content);
    if (bytes > MAX_MIGRATION_BYTES)
      throw new AppDatabaseManifestError(
        "Application migration source exceeds its size limit.",
      );
    paths.push(path);
    migrationFiles.push({
      path,
      sha256: createHash("sha256").update(file.content).digest("hex"),
    });
  }
  if (adapter === "drizzle-postgres") {
    const connectionProblem = managedPostgresConnectionProblem(files) ?? managedDatabaseRenderingProblem(files);
    if (connectionProblem) throw new AppDatabaseManifestError(connectionProblem);
  }
  const manifestPaths = [...paths].sort();
  if (adapter === "drizzle-postgres") {
    const journalFile = files.find(
      (file) => file.path === DRIZZLE_JOURNAL_PATH,
    );
    if (
      !journalFile ||
      Buffer.byteLength(journalFile.content) > MAX_MANIFEST_BYTES
    )
      throw new AppDatabaseManifestError(
        "Drizzle migrations require a bounded saved journal.",
      );
    let journal: unknown;
    try {
      journal = JSON.parse(journalFile.content);
    } catch {
      throw new AppDatabaseManifestError(
        "Drizzle migration journal must contain valid JSON.",
      );
    }
    if (
      !object(journal) ||
      journal.dialect !== "postgresql" ||
      !Array.isArray(journal.entries) ||
      journal.entries.length !== paths.length
    )
      throw new AppDatabaseManifestError(
        "Drizzle journal must match the declared PostgreSQL migration set.",
      );
    let previousTimestamp = -1;
    const journalPaths = new Set<string>();
    for (const [index, entry] of (journal.entries as unknown[]).entries()) {
      if (
        !object(entry) ||
        entry.idx !== index ||
        typeof entry.tag !== "string" ||
        typeof entry.when !== "number" ||
        !Number.isSafeInteger(entry.when) ||
        entry.when <= previousTimestamp ||
        typeof entry.breakpoints !== "boolean" ||
        !paths.includes(`drizzle/${entry.tag}.sql`) ||
        journalPaths.has(entry.tag)
      )
        throw new AppDatabaseManifestError(
          "Drizzle journal entries must uniquely identify the reviewed migrations in timestamp order.",
        );
      previousTimestamp = entry.when;
      journalPaths.add(entry.tag);
    }
    migrationFiles.push({
      path: DRIZZLE_JOURNAL_PATH,
      sha256: createHash("sha256").update(journalFile.content).digest("hex"),
    });
  }
  const undeclared = files.some(
    (file) =>
      (adapter === "laravel"
        ? /^database\/migrations\/.*\.php$/
        : /^drizzle\/.*\.sql$/
      ).test(file.path) && !paths.includes(file.path),
  );
  if (undeclared)
    throw new AppDatabaseManifestError(
      "All executable migration files must belong to the reviewed manifest.",
    );
  migrationFiles.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const manifest: AppDatabaseManifest = {
    version: 1,
    database: {
      engine: "postgresql",
      adapter: adapter as "drizzle-postgres" | "laravel",
      migrations: manifestPaths,
    },
  };
  // Artisan boots the application, so providers/configuration can change a migration's
  // behavior even when its PHP file is unchanged. Review must bind those bytes too.
  // Hash data only; importing or running PHP belongs exclusively inside Docker.
  let source: Array<{ path: string; sha256: string }> | undefined;
  if (adapter === "laravel") {
    if (Buffer.byteLength(JSON.stringify(files)) > MAX_LARAVEL_SOURCE_BYTES)
      throw new AppDatabaseManifestError(
        "Laravel migration application source exceeds its size limit.",
      );
    source = files
      .map((file) => ({
        path: file.path,
        sha256: createHash("sha256").update(file.content).digest("hex"),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
  return {
    manifest,
    files: migrationFiles,
    digest: createHash("sha256")
      // Undefined source is omitted, preserving the existing Next.js digest contract.
      .update(JSON.stringify({ manifest, files: migrationFiles, source }))
      .digest("hex"),
  };
}
