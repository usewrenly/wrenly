/** Official development helpers are inspected through fixed operations, never a model-chosen tool name. */
export const FRAMEWORK_INSPECTION_LIMITS = Object.freeze({
  totalMilliseconds: 45_000,
  callMilliseconds: 10_000,
  maximumCalls: 3,
  maximumReportBytes: 32 * 1024,
  developmentPort: 3000,
});
export const OFFICIAL_FRAMEWORK_RELEASES = Object.freeze({
  laravel: Object.freeze({
    package: "laravel/boost",
    release: "2.10.4",
    commit: "9cd5e7d81300b5dee4c8b1619ec4b36f4a6367fd",
    license: "MIT",
  }),
  nextjs: Object.freeze({
    package: "next-devtools-mcp",
    release: "0.4.0",
    commit: "95794e09857b87d7e6fb3f8caf9a2ee591e3e10f",
    license: "MIT",
  }),
});
export type InspectionFramework = keyof typeof OFFICIAL_FRAMEWORK_RELEASES;
export type FrameworkInspectionRequest =
  | {
      method: "resources/read";
      params: { uri: "file://instructions/application-info.md" };
    }
  | {
      method: "tools/call";
      params: {
        name: "nextjs_call";
        arguments: { port: 3000; toolName: "get_errors" };
      };
    };
export class FrameworkInspectionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrameworkInspectionPolicyError";
  }
}
/** Restrict candidate compatibility to stable major lines; native acceptance is still required. A range is not an installed version. */
export function supportsFrameworkInspection(
  framework: InspectionFramework,
  installedVersion: string,
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(installedVersion);
  if (!match) return false;
  const major = Number(match[1]);
  return framework === "laravel"
    ? major === 13
    : framework === "nextjs" && major === 16;
}
/** The caller supplies only framework/version; addresses and resource URIs stay repository-owned. */
export function frameworkInspectionRequest(
  framework: InspectionFramework,
  installedVersion: string,
): FrameworkInspectionRequest {
  if (!supportsFrameworkInspection(framework, installedVersion))
    throw new FrameworkInspectionPolicyError(
      "Official inspection is unavailable for this framework version.",
    );
  if (framework === "laravel")
    return {
      method: "resources/read",
      params: { uri: "file://instructions/application-info.md" },
    };
  return {
    method: "tools/call",
    params: {
      name: "nextjs_call",
      arguments: { port: 3000, toolName: "get_errors" },
    },
  };
}
/** Runtime tools change between Next.js versions, so discovery must prove get_errors takes no arguments. */
export function assertNoArgumentErrorTool(inputSchema: unknown): void {
  if (
    !inputSchema ||
    typeof inputSchema !== "object" ||
    Array.isArray(inputSchema)
  )
    throw new FrameworkInspectionPolicyError("Missing runtime tool schema.");
  const schema = inputSchema as Record<string, unknown>;
  if (
    schema.type !== "object" ||
    Object.keys(schema).some(
      (key) =>
        ![
          "type",
          "properties",
          "required",
          "additionalProperties",
          "$schema",
        ].includes(key),
    )
  )
    throw new FrameworkInspectionPolicyError(
      "Unsupported runtime tool schema.",
    );
  if (
    schema.properties !== undefined &&
    (!schema.properties ||
      typeof schema.properties !== "object" ||
      Array.isArray(schema.properties) ||
      Object.keys(schema.properties).length !== 0)
  )
    throw new FrameworkInspectionPolicyError(
      "Runtime error inspection unexpectedly accepts arguments.",
    );
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.length !== 0)
  )
    throw new FrameworkInspectionPolicyError(
      "Runtime error inspection unexpectedly requires arguments.",
    );
  if (
    schema.additionalProperties !== undefined &&
    schema.additionalProperties !== false
  )
    throw new FrameworkInspectionPolicyError(
      "Runtime error inspection permits unknown arguments.",
    );
  if (
    schema.$schema !== undefined &&
    schema.$schema !== "http://json-schema.org/draft-07/schema#" &&
    schema.$schema !== "https://json-schema.org/draft/2020-12/schema"
  )
    throw new FrameworkInspectionPolicyError("Unknown runtime schema dialect.");
}
