/** Reject edits to applied migration history before they can reach a disposable rehearsal. */
import { z } from "zod";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import {
  appDatabaseMigrations,
  appDatabaseOperations,
  builds,
  type db,
} from "@wrenly/db";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { AppDatabaseError } from "./database-contract";
type Connection =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
type File = { path: string; content: string };
const MAX_HISTORY_REPAIR_BYTES = 48 * 1024;
/** Known source mismatch before any validation effect; safe to use in the existing repair loop. */
export class MigrationHistoryError extends AppDatabaseError {
  constructor(
    message: string,
    public readonly repairGuidance: string = message,
  ) {
    super(409, message);
    this.name = "MigrationHistoryError";
  }
}

/** Applied files are immutable; new files and journal entries can be appended. */
export function assertMigrationHistoryPrefix(
  previous: File[],
  current: File[],
  framework: "nextjs" | "laravel",
): void {
  const old = readAppDatabaseManifest(previous, framework),
    next = readAppDatabaseManifest(current, framework);
  if (!old || !next)
    throw new AppDatabaseError(
      409,
      "Saved migration history could not be verified.",
    );
  if (
    old.files
      .filter((file) => !file.path.endsWith("_journal.json"))
      .some(
        (file) =>
          !next.files.some(
            (candidate) =>
              candidate.path === file.path && candidate.sha256 === file.sha256,
          ),
      )
  )
    throw new MigrationHistoryError(
      "An already-applied migration was changed or removed. Restore the original file and add a new migration for schema changes.",
    );
  if (framework === "nextjs") {
    const entries = (files: File[]): unknown[] => {
      const value: unknown = JSON.parse(
        files.find((file) => file.path === "drizzle/meta/_journal.json")!
          .content,
      );
      if (
        !value ||
        typeof value !== "object" ||
        !("entries" in value) ||
        !Array.isArray(value.entries)
      )
        throw new Error("Invalid journal");
      return value.entries;
    };
    const before = entries(previous),
      after = entries(current);
    if (
      before.length === after.length &&
      old.digest !== next.digest &&
      old.files.every((file) =>
        next.files.some((candidate) => candidate.path === file.path),
      ) &&
      JSON.stringify(before) === JSON.stringify(after)
    )
      throw new MigrationHistoryError(
        "An unchanged migration journal was reformatted. Restore its exact original bytes, including whitespace and final-newline state.",
      );
    if (
      before.some(
        (entry, index) =>
          JSON.stringify(entry) !== JSON.stringify(after[index]),
      )
    )
      throw new MigrationHistoryError(
        "Already-applied migration journal entries must be preserved. Append new entries instead of rewriting history.",
      );
  }
}
/** Use under the same project locks as review/admission; no Docker or generated code runs here. */
export async function assertAppliedMigrationHistory(
  connection: Connection,
  projectId: string,
  resourceId: string,
  files: File[],
  framework: "nextjs" | "laravel",
): Promise<void> {
  const [previous] = await connection
    .select({ files: builds.files })
    .from(appDatabaseMigrations)
    .innerJoin(
      appDatabaseOperations,
      eq(appDatabaseOperations.id, appDatabaseMigrations.operationId),
    )
    .innerJoin(builds, eq(builds.id, appDatabaseMigrations.buildId))
    .where(
      and(
        eq(appDatabaseMigrations.databaseId, resourceId),
        eq(appDatabaseOperations.databaseId, resourceId),
        eq(appDatabaseOperations.projectId, projectId),
        eq(builds.projectId, projectId),
        eq(appDatabaseOperations.kind, "migrate"),
        eq(appDatabaseOperations.status, "success"),
        isNotNull(appDatabaseOperations.completedAt),
        isNotNull(appDatabaseMigrations.completedAt),
      ),
    )
    .orderBy(
      desc(appDatabaseOperations.completedAt),
      desc(appDatabaseOperations.id),
    )
    .limit(1);
  if (previous) {
    const saved = z
      .array(z.object({ path: z.string(), content: z.string() }))
      .min(1)
      .max(1000)
      .parse(previous.files);
    try {
      assertMigrationHistoryPrefix(saved, files, framework);
    } catch (error) {
      if (!(error instanceof MigrationHistoryError)) throw error;
      const manifest = readAppDatabaseManifest(saved, framework);
      const history = saved.filter((file) =>
        manifest?.files.some((entry) => entry.path === file.path),
      );
      const original = JSON.stringify(history);
      throw new MigrationHistoryError(
        error.message,
        Buffer.byteLength(original) <= MAX_HISTORY_REPAIR_BYTES
          ? `${error.message} Restore these already-applied files exactly, preserving every other current UI/application file. JSON string escapes describe exact file bytes; do not add trailing newlines. Never execute SQL or reset data. Append a separate migration only if the user actually requested a schema change. Original applied files: ${original}`
          : error.message,
      );
    }
  }
}
