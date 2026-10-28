//
// React Query hook for the project list.
// Uses credentials: 'include' so the session cookie is sent.

import { apiFetch } from "@/lib/api";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { parseProjectList, type Project } from "@/lib/projects/collection/contracts";
export type { Project } from "@/lib/projects/collection/contracts";

export class ProjectListError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProjectListError";
  }
}
const PROJECT_REQUEST_TIMEOUT_MS = 10_000
const PROJECT_STALE_MS = 30_000
const PROJECT_POLL_MS = 5_000

async function fetchProjects(archived = false, signal?: AbortSignal): Promise<Project[]> {
  try {
    const res = await apiFetch(
      archived ? "/api/projects?archived=true" : "/api/projects",
      { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(PROJECT_REQUEST_TIMEOUT_MS) },
    );

    // A revoked session is an access failure, not an empty project collection.
    if (res.status === 401)
      throw new ProjectListError(
        "Your session expired. Sign in again to view projects.",
        401,
      );
    if (!res.ok)
      throw new ProjectListError(
        "Projects could not be loaded. Check your connection and try again.",
        res.status,
      );

    return parseProjectList(await res.json());
  } catch (error) {
    if (error instanceof ProjectListError) throw error;
    throw new ProjectListError("Project summaries could not be read. Refresh before continuing.", 0);
  }
}

export function useProjects(
  archived = false,
): UseQueryResult<Project[], Error> {
  return useQuery({
    queryKey: archived ? ["projects", "archived"] : ["projects"],
    queryFn: ({ signal }) => fetchProjects(archived, signal),
    staleTime: PROJECT_STALE_MS,
    refetchInterval: PROJECT_POLL_MS,
    retry: (count, error) =>
      !(error instanceof ProjectListError && error.status === 401) && count < 1,
  });
}
