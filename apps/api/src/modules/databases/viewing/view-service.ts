/**
 * COMPONENT: Authorized database-view read
 * PURPOSE: Return bounded schema/rows only while the same project/resource authority holds.
 * INPUTS: Current actor, explicit resource revision, and a fenced read adapter.
 * OUTPUTS: Bounded text-only viewer data, or refusal with no partial rows.
 * STEPS: Parse, authorize, execute through the adapter, validate its result, authorize
 * again and compare access/resource revisions before returning any data.
 * EDGE CASES: Permission restoration still changes the access revision; schema-only
 * reads never return rows/cursors, and cancellation discards late results.
 * ERROR STATES: Wrong table, extra fields, stale authority and unknown failures fail closed.
 */
import {
  DATABASE_VIEW_LIMITS,
  DatabaseViewerResultSchema,
  type DatabaseViewerResult,
} from "@wrenly/db/app-database-viewer-contract";
import { AppDatabaseError } from "../database-contract";
import { DatabaseViewRequest } from "./view-contract";
import type { DatabaseViewAuthority } from "./view-authority";

const MAX_RESPONSE_BYTES = DATABASE_VIEW_LIMITS.maxResponseBytes;

export interface DatabaseViewServices {
  authority: (
    projectId: string,
    actorId: string,
    input: DatabaseViewRequest,
  ) => Promise<DatabaseViewAuthority>;
  /** Must own a bounded reader-role socket, durable cleanup and cancellation before returning. */
  query: (
    projectId: string,
    actorId: string,
    input: DatabaseViewRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

/** Does not open a socket itself; production must provide the complete fenced read adapter. */
export async function readAuthorizedDatabaseView(
  services: DatabaseViewServices,
  projectId: string,
  actorId: string,
  value: unknown,
  signal: AbortSignal,
): Promise<DatabaseViewerResult> {
  try {
    const parsed = DatabaseViewRequest.safeParse(value);
    if (!parsed.success)
      throw new AppDatabaseError(
        400,
        "Choose a database revision and a valid table/page.",
      );
    const input = Object.freeze(parsed.data);
    signal.throwIfAborted();
    const before = await services.authority(projectId, actorId, input);
    if (
      before.resourceId !== input.resourceId ||
      before.resourceRevision !== input.revision
    )
      throw new AppDatabaseError(
        409,
        "Database revision changed. Reload before inspecting data.",
      );
    const result = DatabaseViewerResultSchema.parse(
      await services.query(projectId, actorId, input, signal),
    );
    signal.throwIfAborted();
    if (
      Buffer.byteLength(JSON.stringify(result)) > MAX_RESPONSE_BYTES ||
      result.table !== (input.table ?? null) ||
      new Set(result.tables).size !== result.tables.length ||
      (result.table !== null && !result.tables.includes(result.table)) ||
      result.rows.some((row) => row.length !== result.columns.length) ||
      (!input.rows && (result.rows.length > 0 || result.nextKey !== null)) ||
      (!input.table &&
        (result.columns.length > 0 ||
          result.rows.length > 0 ||
          result.nextKey !== null))
    )
      throw new AppDatabaseError(
        503,
        "Database returned an inconsistent or oversized view. Reload before trying again.",
      );
    const after = await services.authority(projectId, actorId, input);
    signal.throwIfAborted();
    if (
      after.accessRevision !== before.accessRevision ||
      after.resourceId !== before.resourceId ||
      after.resourceRevision !== before.resourceRevision
    )
      throw new AppDatabaseError(
        409,
        "Project access or database revision changed. Reload before inspecting data.",
      );
    return result;
  } catch (error) {
    if (error instanceof AppDatabaseError) throw error;
    throw new AppDatabaseError(
      503,
      "Database view could not be confirmed. Reload its current status before trying again.",
    );
  }
}
