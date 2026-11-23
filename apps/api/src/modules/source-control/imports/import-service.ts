import { DEFAULT_IMPORT_LIMITS, type SourceImportLimits } from "@wrenly/source-control";
/** Coordinates personal authorization, immutable source review and atomic project admission. */
import type { db } from "@wrenly/db";
import { createGitHubReadClient } from "@wrenly/source-control";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { readConfiguredImportLimits } from "../github/import-limits-store";
import { readSourcePersonalToken } from "../github/connection-store";
import { saveSourceImportReview, admitSourceImport } from "./import-store";
import { readImportSource } from "./import-reader";
const IMPORT_REVIEW_TIMEOUT_MS = 180_000;
const MIN_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 128 * 1024 * 1024;

/** No repository code runs in this request; the saved validation job owns Docker execution. */
export function createSourceImportService(
  database: typeof db,
  directory: string,
  limits: SourceImportLimits = DEFAULT_IMPORT_LIMITS,
): {
  prepare(
    principal: AccessPrincipal,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  confirm(principal: AccessPrincipal, raw: unknown): Promise<unknown>;
} {
  return {
    confirm: async (principal, raw) => {
      const { limits: activeLimits } = await readConfiguredImportLimits(
        directory,
        limits,
      );
      return admitSourceImport(database, principal, raw, activeLimits);
    },
    prepare: async (principal, raw, signal) => {
      // Leave time for a structured response before the API and browser deadlines.
      const reviewSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(IMPORT_REVIEW_TIMEOUT_MS),
      ]);
      const [{ limits: activeLimits }, personal] = await Promise.all([
        readConfiguredImportLimits(directory, limits),
        readSourcePersonalToken(database, principal, directory),
      ]);
      const maxResponseBytes = Math.min(
        MAX_RESPONSE_BYTES,
        Math.max(
          MIN_RESPONSE_BYTES,
          Math.max(activeLimits.fileBytes, activeLimits.assetFileBytes) * 2,
        ),
      );
      const { snapshot, stack, riskFlags } = await readImportSource(
        createGitHubReadClient(personal.token, undefined, { maxResponseBytes }),
        raw,
        reviewSignal,
        activeLimits,
        { allowRiskReview: true },
      );
      reviewSignal.throwIfAborted();
      const reviewSnapshot =
        riskFlags.length > 0
          ? {
              ...snapshot,
              repository: { ...snapshot.repository, riskFlags },
            }
          : snapshot;
      const review = await saveSourceImportReview(
        database,
        principal,
        personal.version,
        reviewSnapshot,
        stack,
        activeLimits,
      );
      return {
        ...review,
        repository: snapshot.repository,
        commitId: snapshot.commitId,
        applicationRoot: snapshot.applicationRoot ?? "",
        stack,
        limits: activeLimits,
        textBytes: snapshot.textBytes ?? 0,
        assetBytes: snapshot.assetBytes ?? 0,
        totalBytes: snapshot.totalBytes ?? 0,
        riskFlags,
        assetCount: snapshot.files.filter((file) => file.asset).length,
      };
    },
  };
}
