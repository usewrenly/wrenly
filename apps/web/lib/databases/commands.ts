/** Explicit commands retain their request UUID across unknown responses; acknowledgement is not execution success. */
import { z } from "zod";
import { DatabaseAction, DatabaseRecoveryAction, DatabaseActionAcknowledgement, DatabaseActionLookup } from "@wrenly/db/app-database-action-contract";
import { apiFetch } from "../api";
const UUID = z.string().uuid();
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_ACKNOWLEDGEMENT_BYTES = 2048;
type Transport = (path: `/api/${string}`, options: RequestInit) => Promise<Response>;
const REJECTED = new Set([400, 403, 404, 408, 409, 413, 415, 429]);

export class DatabaseCommandError extends Error {
  constructor(readonly rejected: boolean) {
    super(rejected ? "The request was not accepted. Reload the current database status before reviewing another action."
      : "The request could not be confirmed. Check its saved acknowledgement before trying again.");
  }
}

async function acknowledgementBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing acknowledgement");
  const reader = response.body.getReader();
  let text = "", bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_ACKNOWLEDGEMENT_BYTES) throw new Error("Oversized acknowledgement");
      text += decoder.decode(part.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Only an explicit click sends this POST. A retry must supply the identical saved action. */
export async function submitDatabaseAction(
  projectId: string, value: DatabaseAction | DatabaseRecoveryAction, signal: AbortSignal, transport: Transport = apiFetch,
): Promise<DatabaseActionAcknowledgement> {
  try {
    UUID.parse(projectId);
    const action = z.union([DatabaseAction, DatabaseRecoveryAction]).parse(value);
    const endpoint = "confirmRecovery" in action ? "recovery" : "actions";
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(COMMAND_TIMEOUT_MS)]);
    const response = await transport(`/api/projects/${projectId}/databases/${endpoint}`, {
      method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
      body: JSON.stringify(action), signal: bounded,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new DatabaseCommandError(REJECTED.has(response.status));
    }
    return DatabaseActionAcknowledgement.parse(await acknowledgementBody(response, bounded));
  } catch (error) {
    if (error instanceof DatabaseCommandError) throw error;
    throw new DatabaseCommandError(false);
  }
}

/** A missing receipt is not proof that an earlier in-flight POST cannot still commit. */
export async function lookupDatabaseAction(
  projectId: string, requestId: string, signal: AbortSignal, transport: Transport = apiFetch, recovery = false,
): Promise<DatabaseActionAcknowledgement | null> {
  try {
    UUID.parse(projectId); UUID.parse(requestId);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(COMMAND_TIMEOUT_MS)]);
    const response = await transport(`/api/projects/${projectId}/databases/${recovery ? "recovery" : "actions"}/${requestId}`, { cache: "no-store", signal: bounded });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Lookup unavailable"); }
    return DatabaseActionLookup.parse(await acknowledgementBody(response, bounded)).acknowledgement;
  } catch { throw new DatabaseCommandError(false); }
}
