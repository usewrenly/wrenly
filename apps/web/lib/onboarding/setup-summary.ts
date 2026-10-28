// Reads safe authenticated configuration facts without probing providers or executing work.
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { apiFetch } from "../api";
const SETUP_SUMMARY_TIMEOUT_MS = 10_000;

export interface SetupSummary {
  role: "owner" | "user";
  accountConfigured: boolean;
  providerConfigured: boolean;
  hasProjects: boolean;
  defaultModel: {
    state: "configured" | "missing" | "disabled" | "unavailable";
    modelId: string | null;
    providerLabel: string | null;
    source: "saved" | "environment" | null;
  };
  preview: "enabled" | "operator-setup";
  publishing: "enabled" | "operator-setup";
  connectionHealth: "not-checked";
}
/** Rejects unreadable progress rather than interpreting a service failure as an empty instance. */
export function parseSetupSummary(raw: unknown): SetupSummary {
  if (!raw || typeof raw !== "object")
    throw new Error("Setup progress could not be read.");
  const value = raw as Record<string, unknown>,
    model = value.defaultModel as Record<string, unknown> | null;
  if (
    !["owner", "user"].includes(String(value.role)) ||
    !["accountConfigured", "providerConfigured", "hasProjects"].every(
      (key) => typeof value[key] === "boolean",
    ) ||
    !model ||
    typeof model !== "object" ||
    !["configured", "missing", "disabled", "unavailable"].includes(
      String(model.state),
    ) ||
    ![model.modelId, model.providerLabel].every(
      (item) => item === null || typeof item === "string",
    ) ||
    !["saved", "environment", null].includes(model.source as string | null) ||
    !["preview", "publishing"].every((key) =>
      ["enabled", "operator-setup"].includes(String(value[key])),
    ) ||
    value.connectionHealth !== "not-checked"
  )
    throw new Error(
      "Setup progress returned incomplete information. Try again.",
    );
  return {
    role: value.role as SetupSummary["role"],
    accountConfigured: value.accountConfigured as boolean,
    providerConfigured: value.providerConfigured as boolean,
    hasProjects: value.hasProjects as boolean,
    preview: value.preview as SetupSummary["preview"],
    publishing: value.publishing as SetupSummary["publishing"],
    connectionHealth: "not-checked",
    defaultModel: {
      state: model.state as SetupSummary["defaultModel"]["state"],
      modelId: model.modelId as string | null,
      providerLabel: model.providerLabel as string | null,
      source: model.source as SetupSummary["defaultModel"]["source"],
    },
  };
}
/** Refreshes persisted setup facts on each visit; it never probes or invokes a model. */
export function useSetupSummary(): UseQueryResult<SetupSummary, Error> {
  return useQuery({
    queryKey: ["setup-summary"],
    queryFn: async ({ signal }): Promise<SetupSummary> => {
      try {
        const response = await apiFetch("/api/instance/setup-summary", {
          cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(SETUP_SUMMARY_TIMEOUT_MS)]),
        });
        if (response.status === 401)
          throw new Error("Sign in again to view setup progress.");
        if (!response.ok)
          throw new Error("Setup progress is unavailable. Try again.");
        return parseSetupSummary(await response.json());
      } catch (error) {
        throw new Error(
          error instanceof Error
            ? error.message
            : "Setup progress is unavailable.",
          { cause: error },
        );
      }
    },
    retry: false,
    staleTime: 0,
  });
}
