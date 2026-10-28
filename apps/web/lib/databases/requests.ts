/** Authenticated, bounded database reads; selection changes abort old responses instead of retaining stale rows. */
import { z } from "zod";
import { DatabaseRecoveryReview, DatabaseMigrationReview, DatabaseResourceStatus, DATABASE_STATUS_LIMITS } from "@wrenly/db/app-database-resource-contract";
import { DatabaseViewerSelection, DatabaseViewerResultSchema, DATABASE_VIEW_LIMITS, type DatabaseViewerResult } from "@wrenly/db/app-database-viewer-contract";
import { apiFetch } from "../api";

const READ_TIMEOUT_MS = 15_000;
const ProjectId = z.string().uuid();
type ReadTransport = (path: `/api/${string}`, options: RequestInit) => Promise<Response>;

async function readJson(response: Response, maximumBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Database information could not be loaded. Reload its current status.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximumBytes) throw new Error("Database response exceeds its display limit.");
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Loading status does not provision resources, start a preview or query application rows. */
export async function requestDatabaseStatus(projectId: string, signal: AbortSignal, transport: ReadTransport = apiFetch): Promise<DatabaseResourceStatus> {
  try {
    ProjectId.parse(projectId);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    const response = await transport(`/api/projects/${projectId}/databases`, { cache: "no-store", signal: bounded });
    const result = DatabaseResourceStatus.parse(await readJson(response, DATABASE_STATUS_LIMITS.bytes, bounded));
    if (result.resources.some((resource) => resource.projectId !== projectId)) throw new Error("Wrong project response");
    bounded.throwIfAborted();
    return result;
  } catch {
    throw new Error("Database status is unavailable. Reload before continuing.");
  }
}

/** Each explicit read names one saved resource revision; no SQL or connection setting is accepted. */
export async function requestDatabaseView(
  projectId: string, selection: DatabaseViewerSelection, signal: AbortSignal, transport: ReadTransport = apiFetch,
): Promise<DatabaseViewerResult> {
  try {
    ProjectId.parse(projectId);
    const input = DatabaseViewerSelection.parse(selection);
    const query = new URLSearchParams({ resourceId: input.resourceId, revision: input.revision,
      environment: input.environment, rows: String(input.rows) });
    if (input.table !== undefined) query.set("table", input.table);
    if (input.after !== undefined) query.set("after", input.after);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    const response = await transport(`/api/projects/${projectId}/databases/view?${query}`, { cache: "no-store", signal: bounded });
    const result = DatabaseViewerResultSchema.parse(await readJson(response, DATABASE_VIEW_LIMITS.maxResponseBytes, bounded));
    if (result.table !== (input.table ?? null) || new Set(result.tables).size !== result.tables.length ||
        (result.table !== null && !result.tables.includes(result.table)) ||
        result.rows.some((row) => row.length !== result.columns.length) ||
        (!input.rows && (result.rows.length > 0 || result.nextKey !== null)) ||
        (!input.table && (result.columns.length > 0 || result.rows.length > 0 || result.nextKey !== null)))
      throw new Error("Database view does not match its selection");
    bounded.throwIfAborted();
    return result;
  } catch {
    throw new Error("Database view is unavailable. Reload the resource before trying again.");
  }
}

/** Review is tied to the selected saved revision, never an implicit latest build. */
export async function requestDatabaseMigrationReview(projectId: string, resourceId: string, buildId: string,
  signal: AbortSignal, transport: ReadTransport = apiFetch): Promise<DatabaseMigrationReview> {
  try {
    ProjectId.parse(projectId); ProjectId.parse(resourceId); ProjectId.parse(buildId);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    const query = new URLSearchParams({ resourceId, buildId });
    const response = await transport(`/api/projects/${projectId}/databases/migration-review?${query}`, { cache: "no-store", signal: bounded });
    const result = DatabaseMigrationReview.parse(await readJson(response, 768 * 1024, bounded));
    if (result.projectId !== projectId || result.resourceId !== resourceId || result.buildId !== buildId) throw new Error("Review identity changed");
    bounded.throwIfAborted();
    return result;
  } catch { throw new Error("Migration review is unavailable. Check the selected revision and current database status."); }
}

/** Recovery review exposes only permitted inspection choices for the selected interrupted operation. */
export async function requestDatabaseRecoveryReview(projectId: string, resourceId: string, operationId: string,
  signal: AbortSignal, transport: ReadTransport = apiFetch): Promise<DatabaseRecoveryReview> {
  try {
    ProjectId.parse(projectId); ProjectId.parse(resourceId); ProjectId.parse(operationId);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(READ_TIMEOUT_MS)]);
    const query = new URLSearchParams({ resourceId, operationId });
    const response = await transport(`/api/projects/${projectId}/databases/recovery-review?${query}`, { cache: "no-store", signal: bounded });
    const result = DatabaseRecoveryReview.parse(await readJson(response, DATABASE_STATUS_LIMITS.bytes, bounded));
    if (result.projectId !== projectId || result.resourceId !== resourceId || result.operationId !== operationId) throw new Error("Recovery identity changed");
    bounded.throwIfAborted(); return result;
  } catch { throw new Error("Recovery review is unavailable. Reload database status before continuing."); }
}
