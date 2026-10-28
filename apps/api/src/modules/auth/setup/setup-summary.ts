/**
 * Authenticated onboarding progress summary.
 * Reports safe saved configuration facts and actionable setup steps.
 * Configuration flags do not prove provider, preview or publishing health; never return credentials or probe providers during a summary read.
 */
import { count, eq, isNotNull } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  instanceSetup,
  providerConnections,
  instanceModelDefault,
  projects,
} from "../../../../../../packages/db/src/schema";
import { getProvider } from "../../models/environment/providers";
import { describeEnvironmentProvider } from "../../models/environment/environment-providers";
import { logger } from "../../../lib/logger";
export interface SetupSummary {
  role: "owner" | "user";
  accountConfigured: boolean;
  providerConfigured: boolean;
  defaultModel: {
    state: "configured" | "missing" | "disabled" | "unavailable";
    modelId: string | null;
    providerLabel: string | null;
    source: "saved" | "environment" | null;
  };
  hasProjects: boolean;
  preview: "enabled" | "operator-setup";
  publishing: "enabled" | "operator-setup";
  connectionHealth: "not-checked";
}
interface SummaryFacts {
  ownerId: string | null;
  actorId: string;
  hasProjects: boolean;
  previewEnabled: boolean;
  publishingEnabled: boolean;
  connections: Array<{
    id: string;
    label: string;
    enabled: boolean;
    protocol: string;
    kind: string;
    credentialPresent: boolean;
    envSourceId: string | null;
  }>;
  savedDefault: { connectionId: string; modelId: string } | null;
  legacy: {
    id: string;
    label: string;
    configured: boolean;
    modelId: string | null;
  } | null;
}
/** Derives progress only from persisted configuration; no token, endpoint, network check or owner identity is returned. */
export function summarizeSetup(facts: SummaryFacts): SetupSummary {
  const usable = (connection: SummaryFacts["connections"][number]): boolean =>
    connection.enabled &&
    ["ollama", "openai-compatible"].includes(connection.protocol) &&
    ["local", "cloud"].includes(connection.kind) &&
    (connection.kind === "local" || connection.credentialPresent);
  const legacy =
    facts.legacy &&
    !facts.connections.some(
      (connection) => connection.envSourceId === facts.legacy!.id,
    )
      ? facts.legacy
      : null;
  let defaultModel: SetupSummary["defaultModel"] = {
    state: "missing",
    modelId: null,
    providerLabel: null,
    source: null,
  };
  if (facts.savedDefault) {
    const selected = facts.connections.find(
      (connection) => connection.id === facts.savedDefault!.connectionId,
    );
    defaultModel = {
      state: !selected
        ? "unavailable"
        : !selected.enabled
          ? "disabled"
          : usable(selected)
            ? "configured"
            : "unavailable",
      modelId: facts.savedDefault.modelId,
      providerLabel: selected?.label ?? null,
      source: "saved",
    };
  } else if (legacy?.configured && legacy.modelId)
    defaultModel = {
      state: "configured",
      modelId: legacy.modelId,
      providerLabel: legacy.label,
      source: "environment",
    };
  return {
    role: facts.ownerId === facts.actorId ? "owner" : "user",
    accountConfigured: Boolean(facts.ownerId),
    providerConfigured:
      facts.connections.some(usable) || Boolean(legacy?.configured),
    defaultModel,
    hasProjects: facts.hasProjects,
    preview: facts.previewEnabled ? "enabled" : "operator-setup",
    publishing: facts.publishingEnabled ? "enabled" : "operator-setup",
    connectionHealth: "not-checked",
  };
}
/** Reads safe projections only; startup settings, keys and provider health remain operator/server concerns. */
export async function getSetupSummary(
  database: typeof db,
  actorId: string,
  configuration: { previewEnabled: boolean; publishingEnabled: boolean },
): Promise<SetupSummary> {
  try {
    let legacy: SummaryFacts["legacy"] = null;
    try {
      const provider = getProvider(undefined),
        metadata = describeEnvironmentProvider(provider);
      legacy = {
        id: metadata.id,
        label: metadata.label,
        configured:
          metadata.id !== "ollama" ||
          Boolean(
            process.env.WRENLY_OLLAMA_URL || process.env.WRENLY_MODEL_NAME,
          ),
        modelId: process.env.WRENLY_MODEL_NAME ?? null,
      };
    } catch {
      /* Invalid compatibility settings are not treated as configured inference. */
    }
    return await database.transaction(async (tx) => {
      const [setup] = await tx
        .select({ ownerId: instanceSetup.ownerId })
        .from(instanceSetup)
        .where(eq(instanceSetup.id, 1));
      const connections = await tx
        .select({
          id: providerConnections.id,
          label: providerConnections.label,
          enabled: providerConnections.enabled,
          protocol: providerConnections.protocol,
          kind: providerConnections.kind,
          credentialPresent: isNotNull(providerConnections.credential),
          envSourceId: providerConnections.envSourceId,
        })
        .from(providerConnections);
      const [savedDefault] = await tx
        .select({
          connectionId: instanceModelDefault.connectionId,
          modelId: instanceModelDefault.modelId,
        })
        .from(instanceModelDefault)
        .where(eq(instanceModelDefault.id, 1));
      const [ownProjects] = await tx
        .select({ value: count() })
        .from(projects)
        .where(eq(projects.userId, actorId));
      return summarizeSetup({
        actorId,
        ownerId: setup?.ownerId ?? null,
        connections: connections.map((connection) => ({
          ...connection,
          credentialPresent: connection.credentialPresent === true,
        })),
        savedDefault: savedDefault ?? null,
        hasProjects: (ownProjects?.value ?? 0) > 0,
        legacy,
        ...configuration,
      });
    });
  } catch (error) {
    logger.error("Setup summary unavailable", {
      operation: "read setup facts",
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new Error(
      "Setup progress could not be read. Check the API and database migrations.",
      { cause: error },
    );
  }
}
/** Requires a real session before reading configuration facts; failures are never returned as incomplete setup. */
export function createSetupSummaryHandler(dependencies: {
  userId: (headers: Headers) => Promise<string | null>;
  summary: (actorId: string) => Promise<SetupSummary>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const headers = { "Cache-Control": "no-store, private", Vary: "Cookie" };
    try {
      const actorId = await dependencies.userId(request.headers);
      if (!actorId)
        return Response.json(
          { error: "Sign in to view setup progress." },
          { status: 401, headers },
        );
      return Response.json(await dependencies.summary(actorId), { headers });
    } catch {
      return Response.json(
        { error: "Setup progress is unavailable. Try again." },
        { status: 503, headers },
      );
    }
  };
}
