/** Coordinates personal authorization, immutable source review and atomic project admission. */
import type { db } from "@wrenly/db";
import { createGitHubReadClient } from "@wrenly/source-control";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { readSourcePersonalToken } from "../github/connection-store";
import { saveSourceImportReview, admitSourceImport } from "./import-store";
import { readImportSource } from "./import-reader";
const IMPORT_REVIEW_TIMEOUT_MS = 45_000;

/** No repository code runs in this request; the saved validation job owns Docker execution. */
export function createSourceImportService(
  database: typeof db,
  directory: string,
): {
  prepare(
    principal: AccessPrincipal,
    raw: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
  confirm(principal: AccessPrincipal, raw: unknown): Promise<unknown>;
} {
  return {
    confirm: (principal, raw) => admitSourceImport(database, principal, raw),
    prepare: async (principal, raw, signal) => {
      // Leave time for a structured response before the API and browser deadlines.
      const reviewSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(IMPORT_REVIEW_TIMEOUT_MS),
      ]);
      const personal = await readSourcePersonalToken(
        database,
        principal,
        directory,
      );
      const { snapshot, stack } = await readImportSource(
        createGitHubReadClient(personal.token),
        raw,
        reviewSignal,
      );
      reviewSignal.throwIfAborted();
      const review = await saveSourceImportReview(
        database,
        principal,
        personal.version,
        snapshot,
        stack,
      );
      return {
        ...review,
        repository: snapshot.repository,
        commitId: snapshot.commitId,
        applicationRoot: snapshot.applicationRoot ?? "",
        stack,
      };
    },
  };
}
