import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { instanceSetup, type db } from "@wrenly/db";
import {
  DEFAULT_IMPORT_LIMITS,
  IMPORT_LIMIT_PRESETS,
  resolveImportLimitsPreset,
  type ImportLimitPresetId,
  type SourceImportLimits,
} from "@wrenly/source-control";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { assertSourcePrincipal, SourceConnectionError } from "./authorization-store";

const LIMITS_FILE_NAME = "github-import-limits.json";
const MAX_LIMITS_FILE_BYTES = 1024;
const StoredLimitsSchema = z
  .object({
    preset: z.enum(["default", "medium", "large", "unlimited"]),
  })
  .strict();

const UpdateLimitsSchema = z
  .object({
    preset: z.enum(["default", "medium", "large", "unlimited"]).optional(),
    reset: z.boolean().optional(),
  })
  .strict();

function matchPreset(limits: SourceImportLimits): ImportLimitPresetId {
  for (const entry of Object.values(IMPORT_LIMIT_PRESETS)) {
    const preset = entry.limits;
    if (
      preset.files === limits.files &&
      preset.fileBytes === limits.fileBytes &&
      preset.totalBytes === limits.totalBytes &&
      preset.assetFileBytes === limits.assetFileBytes &&
      preset.assetBytes === limits.assetBytes
    ) {
      return entry.id;
    }
  }
  return "default";
}

/**
 * Reads the active instance GitHub import limit preset from disk,
 * falling back cleanly to startup/environment defaults when unset.
 */
export async function readConfiguredImportLimits(
  directory: string,
  fallback: SourceImportLimits = DEFAULT_IMPORT_LIMITS,
): Promise<{ preset: ImportLimitPresetId; limits: SourceImportLimits }> {
  try {
    const raw = await readFile(join(directory, LIMITS_FILE_NAME), "utf8");
    if (raw.length > MAX_LIMITS_FILE_BYTES) {
      return { preset: matchPreset(fallback), limits: fallback };
    }
    const parsed = StoredLimitsSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      return { preset: matchPreset(fallback), limits: fallback };
    }
    return {
      preset: parsed.data.preset,
      limits: resolveImportLimitsPreset(parsed.data.preset),
    };
  } catch {
    return { preset: matchPreset(fallback), limits: fallback };
  }
}

/**
 * Updates or resets the GitHub import limit profile after verifying that the
 * caller is the verified instance owner with an active account session.
 */
export async function saveConfiguredImportLimits(
  database: typeof db,
  directory: string,
  principal: AccessPrincipal,
  raw: unknown,
): Promise<{
  preset: ImportLimitPresetId;
  limits: SourceImportLimits;
  canManage: boolean;
}> {
  const input = UpdateLimitsSchema.safeParse(raw);
  if (!input.success) {
    throw new SourceConnectionError(
      400,
      "Choose an import limit profile or reset to defaults.",
    );
  }
  const targetPreset: ImportLimitPresetId | undefined = input.data.reset
    ? "default"
    : input.data.preset;
  if (!targetPreset) {
    throw new SourceConnectionError(
      400,
      "Choose an import limit profile or reset to defaults.",
    );
  }

  await database.transaction(async (tx) => {
    await assertSourcePrincipal(tx, principal);
    const [setup] = await tx
      .select({ ownerId: instanceSetup.ownerId })
      .from(instanceSetup)
      .where(eq(instanceSetup.id, 1))
      .for("share");
    if (!setup?.ownerId || setup.ownerId !== principal.userId) {
      throw new SourceConnectionError(
        403,
        "Only the instance owner can change GitHub import limits.",
      );
    }
  });

  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, LIMITS_FILE_NAME),
    JSON.stringify({ preset: targetPreset }, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600 },
  );

  return {
    preset: targetPreset,
    limits: resolveImportLimitsPreset(targetPreset),
    canManage: true,
  };
}
