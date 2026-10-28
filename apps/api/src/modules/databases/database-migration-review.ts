// Binds an owner-reviewed successful revision to an exact verified resource backup.
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import { builds, appDatabaseBackups, appDatabaseOperations } from "@wrenly/db";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { AppDatabaseError } from "./database-contract";

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const Files = z
  .array(z.object({ path: z.string(), content: z.string() }).strict())
  .min(1)
  .max(1000);
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Bounds saved application bytes before manifest review; this never loads or executes source. */
export function readDatabaseApplicationSource(value: unknown): Array<{ path: string; content: string }> {
  const files = Files.parse(value);
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_SOURCE_BYTES)
    throw new Error("Saved database application source exceeds its bound");
  return files;
}

/** Revalidates stored source; a build ID alone is never migration authority. */
export function readFrozenMigrationSource(
  value: unknown,
  expectedDigest: string,
  framework: "nextjs" | "laravel" = "nextjs",
): {
  files: Array<{ path: string; content: string }>;
  manifest: Array<{ path: string; sha256: string }>;
} {
  const files = readDatabaseApplicationSource(value);
  const set = readAppDatabaseManifest(files, framework);
  if (!set || set.digest !== expectedDigest)
    throw new Error("Frozen migration source changed");
  return { files, manifest: set.files };
}

/** Called only inside ordered admission locks after current owner/revision checks. */
export async function prepareDatabaseMigrationReview(
  tx: Transaction,
  input: {
    projectId: string;
    resourceId: string;
    buildId: string;
    backupId: string;
    migrationDigest: string;
  },
): Promise<{
  backupId: string;
  beforeSchemaDigest: string;
  manifest: Array<{ path: string; sha256: string }>;
}> {
  try {
    const [build] = await tx
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.id, input.buildId),
          eq(builds.projectId, input.projectId),
          eq(builds.status, "success"),
        ),
      );
    if (!build || (build.stack !== "nextjs" && build.stack !== "laravel"))
      throw new Error(
        "This migration adapter requires a successful Next.js or Laravel revision",
      );
    const source = readFrozenMigrationSource(
      build.files,
      input.migrationDigest,
      build.stack,
    );
    const [backup] = await tx
      .select({ backup: appDatabaseBackups })
      .from(appDatabaseBackups)
      .innerJoin(
        appDatabaseOperations,
        eq(appDatabaseOperations.id, appDatabaseBackups.operationId),
      )
      .where(
        and(
          eq(appDatabaseBackups.id, input.backupId),
          eq(appDatabaseBackups.databaseId, input.resourceId),
          eq(appDatabaseOperations.projectId, input.projectId),
          eq(appDatabaseOperations.kind, "backup"),
          eq(appDatabaseOperations.status, "success"),
          isNotNull(appDatabaseBackups.verifiedAt),
        ),
      );
    if (
      !backup?.backup.schemaDigest ||
      !/^[a-f0-9]{64}$/.test(backup.backup.schemaDigest)
    )
      throw new Error("A restored, verified resource backup is required");
    return {
      backupId: backup.backup.id,
      beforeSchemaDigest: backup.backup.schemaDigest,
      manifest: source.manifest,
    };
  } catch {
    throw new AppDatabaseError(
      409,
      "Review a successful supported revision and a verified backup of this database before confirming migrations.",
    );
  }
}
