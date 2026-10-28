// Validates saved ideas and their permissions; loading a draft never starts a build.
import { apiFetch } from "../../api";
const DRAFT_REQUEST_TIMEOUT_MS = 10_000 // Preserve an uncertain save instead of waiting indefinitely.

export interface DraftMember {
  userId: string;
  name: string;
  role: "viewer" | "editor";
}
export interface ProjectDraft {
  id: string;
  title: string;
  body: string;
  revision: string;
  accessMode: "private" | "selected" | "instance";
  instanceRole: "viewer" | "editor";
  archivedAt: string | null;
  updatedAt: string;
  updatedByName: string;
  capabilities: {
    role: "owner" | "editor" | "viewer";
    contribute: boolean;
    manage: boolean;
  };
  members: DraftMember[];
}
export interface DraftSummary {
  id: string;
  title: string;
  revision: string;
  accessMode: ProjectDraft["accessMode"];
  archivedAt: string | null;
  updatedAt: string;
  owned: boolean;
}
export class DraftRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export function draftObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Draft response could not be read.");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Incomplete draft response.");
  return value;
}
function date(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result)))
    throw new Error("Invalid draft date.");
  return result;
}
/** Rejects incomplete authority metadata rather than enabling editor controls by default. */
export function parseDraft(value: unknown, expectedId?: string): ProjectDraft {
  const row = draftObject(value),
    caps = draftObject(row.capabilities);
  if (
    !["owner", "editor", "viewer"].includes(string(caps.role)) ||
    typeof caps.contribute !== "boolean" ||
    typeof caps.manage !== "boolean" ||
    !["private", "selected", "instance"].includes(string(row.accessMode)) ||
    !["viewer", "editor"].includes(string(row.instanceRole)) ||
    (caps.role === "viewer" && (caps.contribute || caps.manage)) ||
    (caps.role === "editor" && caps.manage) ||
    !Array.isArray(row.members)
  )
    throw new Error("Draft permissions could not be read.");
  if (expectedId !== undefined && row.id !== expectedId)
    throw new Error("The returned draft does not match the selected idea. Refresh before saving.");
  return {
    id: string(row.id),
    title: string(row.title),
    body: string(row.body),
    revision: string(row.revision),
    accessMode: row.accessMode as ProjectDraft["accessMode"],
    instanceRole: row.instanceRole as ProjectDraft["instanceRole"],
    archivedAt: row.archivedAt === null ? null : date(row.archivedAt),
    updatedAt: date(row.updatedAt),
    updatedByName: string(row.updatedByName),
    capabilities: {
      role: caps.role as ProjectDraft["capabilities"]["role"],
      contribute: caps.contribute,
      manage: caps.manage,
    },
    members: row.members.map((item) => {
      const person = draftObject(item);
      if (!["viewer", "editor"].includes(string(person.role)))
        throw new Error("Invalid member role.");
      return {
        userId: string(person.userId),
        name: string(person.name),
        role: person.role as DraftMember["role"],
      };
    }),
  };
}
/** Bounds request duration; uncertain failures keep the caller's frozen mutation identity. */
export async function draftRequest(
  path: `/api/${string}`,
  input?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    const timeout = AbortSignal.timeout(DRAFT_REQUEST_TIMEOUT_MS);
    const response = await apiFetch(path, {
      method: input ? (path === "/api/drafts" ? "POST" : "PATCH") : "GET",
      cache: "no-store",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: input ? { "Content-Type": "application/json" } : undefined,
      body: input ? JSON.stringify(input) : undefined,
    });
    const result = draftObject(await response.json());
    if (!response.ok)
      throw new DraftRequestError(
        response.status,
        typeof result.error === "string"
          ? result.error
          : "Draft request failed.",
      );
    return result;
  } catch (error) {
    if (error instanceof DraftRequestError) throw error;
    throw new DraftRequestError(
      503,
      "Draft operation could not be confirmed. Keep your text and retry.",
    );
  }
}
export function parseDraftList(value: unknown): {
  drafts: DraftSummary[];
  hasMore: boolean;
} {
  const row = draftObject(value);
  if (!Array.isArray(row.drafts) || typeof row.hasMore !== "boolean")
    throw new Error("Draft list could not be read.");
  return {
    drafts: row.drafts.map((value) => {
      const item = draftObject(value);
      if (typeof item.owned !== "boolean")
        throw new Error("Invalid draft owner.");
      if (!["private", "selected", "instance"].includes(string(item.accessMode)))
        throw new Error("Draft sharing mode could not be read.");
      return {
        id: string(item.id),
        title: string(item.title),
        revision: string(item.revision),
        accessMode: item.accessMode as ProjectDraft["accessMode"],
        archivedAt: item.archivedAt === null ? null : date(item.archivedAt),
        updatedAt: date(item.updatedAt),
        owned: item.owned,
      };
    }),
    hasMore: row.hasMore,
  };
}
