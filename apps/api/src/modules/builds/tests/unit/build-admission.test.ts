import { describe, expect, test } from "bun:test";
import { GenerateRequestSchema } from "../../admission/build-contract";
import {
  buildRequestIdentity,
  resolveBuildJobInput,
} from "../../admission/build-admission";
import type { builds } from "../../../../../../../packages/db/src/schema";

const PROJECT_ID = "101e4567-e89b-12d3-a456-426614174007";
const BUILD_ID = "201e4567-e89b-12d3-a456-426614174007";
const dependencies = {
  defaultModel: "default-model",
  resolveProvider: (id: string | undefined): { id: string } => {
    if (id === "missing") throw new Error("Private configuration detail");
    return { id: id ?? "default-provider" };
  },
};
function parent(): typeof builds.$inferSelect {
  return {
    id: BUILD_ID,
    projectId: PROJECT_ID,
    prompt: "Original request",
    model: "saved-model",
    provider: "saved-provider",
    stack: "nextjs",
    parentBuildId: null,
    status: "failed",
    attemptCount: 3,
    files: [{ path: "package.json", content: "{}" }],
    buildLog: "Compiler diagnostics",
    errorMessage: "Compilation failed",
    deployedUrl: null,
    createdAt: new Date(),
    completedAt: new Date(),
  };
}

describe("immutable build admission inputs", () => {
  test("normalizes omitted defaults without depending on object property order", () => {
    const first = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      prompt: "Build app",
    });
    const second = GenerateRequestSchema.parse({
      prompt: "Build app",
      deploy: false,
      projectId: PROJECT_ID,
    });
    expect(buildRequestIdentity(first)).toBe(buildRequestIdentity(second));
    expect(buildRequestIdentity({ ...first, model: "another-model" })).not.toBe(
      buildRequestIdentity(first),
    );
  });
  test("resolves explicit settings and never stores provider credentials", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      prompt: "Build app",
      model: "chosen",
    });
    expect(
      resolveBuildJobInput(input, "nextjs", undefined, dependencies),
    ).toEqual({
      prompt: "Build app",
      stack: "nextjs",
      model: "chosen",
      provider: "default-provider",
      previousFiles: [],
      previousErrors: [],
    });
  });
  test("explicit retry freezes original prompt/settings/source and errors", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      retryBuildId: BUILD_ID,
    });
    const original = parent();
    const resolved = resolveBuildJobInput(
      input,
      "nextjs",
      original,
      dependencies,
    );
    expect(resolved.model).toBe("saved-model");
    expect(resolved.provider).toBe("saved-provider");
    expect(resolved.prompt).toBe("Original request");
    expect(resolved.previousErrors).toEqual([
      "Compilation failed\nCompiler diagnostics",
    ]);
    const files = original.files as Array<{ path: string; content: string }>;
    files[0]!.content = "changed after admission";
    expect(resolved.previousFiles[0]?.content).toBe("{}");
  });
  test("follow-up uses new prompt/settings and source without importing repair errors", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      prompt: "Add search",
      previousBuildId: BUILD_ID,
    });
    const resolved = resolveBuildJobInput(
      input,
      "nextjs",
      parent(),
      dependencies,
    );
    expect(resolved.prompt).toBe("Add search");
    expect(resolved.model).toBe("default-model");
    expect(resolved.previousErrors).toEqual([]);
    expect(resolved.previousFiles).toHaveLength(1);
  });
  test("rejects foreign sources, stack mismatch and unfinished parents", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      prompt: "Add search",
      previousBuildId: BUILD_ID,
    });
    expect(() =>
      resolveBuildJobInput(
        input,
        "nextjs",
        { ...parent(), projectId: crypto.randomUUID() },
        dependencies,
      ),
    ).toThrow("not found");
    expect(() =>
      resolveBuildJobInput(input, "vue", parent(), dependencies),
    ).toThrow("stack");
    expect(() =>
      resolveBuildJobInput(
        input,
        "nextjs",
        { ...parent(), status: "building" },
        dependencies,
      ),
    ).toThrow("in progress");
  });
  test("rejects legacy retries without guessing original model settings", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      retryBuildId: BUILD_ID,
    });
    expect(() =>
      resolveBuildJobInput(
        input,
        "nextjs",
        { ...parent(), model: null },
        dependencies,
      ),
    ).toThrow("saved model settings");
    expect(() =>
      resolveBuildJobInput(
        input,
        "nextjs",
        { ...parent(), status: "success" },
        dependencies,
      ),
    ).toThrow("failed build");
  });
  test("does not schedule deployment or expose provider configuration errors", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      prompt: "Build app",
    });
    expect(() =>
      resolveBuildJobInput(
        { ...input, deploy: true },
        "nextjs",
        undefined,
        dependencies,
      ),
    ).toThrow("separate action");
    expect(() =>
      resolveBuildJobInput(
        { ...input, provider: "missing" },
        "nextjs",
        undefined,
        dependencies,
      ),
    ).toThrow("selected model provider is unavailable");
  });
  test("rejects malformed source and caps retry diagnostic context", () => {
    const input = GenerateRequestSchema.parse({
      projectId: PROJECT_ID,
      retryBuildId: BUILD_ID,
    });
    expect(() =>
      resolveBuildJobInput(
        input,
        "nextjs",
        { ...parent(), files: "invalid" },
        dependencies,
      ),
    ).toThrow("invalid source");
    const resolved = resolveBuildJobInput(
      input,
      "nextjs",
      { ...parent(), buildLog: "x".repeat(10_000) },
      dependencies,
    );
    expect(resolved.previousErrors[0]?.length).toBe(6000);
  });
});

// A database address or password never belongs in a build request; only an existing resource identity does.
test("explicit Development choice is opt-in, identity-bound and cannot override saved retry settings", async () => {
  const { resolveRequestedBuildDatabase } = await import("../../admission/build-admission");
  const database = { version: 1 as const, environment: "development" as const,
    resourceId: crypto.randomUUID(), resourceRevision: crypto.randomUUID() };
  const input = GenerateRequestSchema.parse({ projectId: PROJECT_ID, prompt: "Build a booking app", database });
  expect(() => resolveRequestedBuildDatabase(input, {})).toThrow("not enabled");
  expect(resolveRequestedBuildDatabase(input, { allowDatabaseSelection: true })).toEqual(database);
  expect(() => resolveRequestedBuildDatabase(input, { allowDatabaseSelection: true, databaseSelection: database })).toThrow("cannot be replaced");
  expect(buildRequestIdentity(input)).not.toBe(buildRequestIdentity({ ...input, database: { ...database, resourceRevision: crypto.randomUUID() } }));
  expect(GenerateRequestSchema.safeParse({ projectId: PROJECT_ID, retryBuildId: BUILD_ID, database }).success).toBe(false);
  expect(GenerateRequestSchema.safeParse({ projectId: PROJECT_ID, prompt: "Build", database: { ...database, password: "PRIVATE" } }).success).toBe(false);
  expect(GenerateRequestSchema.safeParse({ projectId: PROJECT_ID, prompt: "Build", database: { ...database, environment: "production" } }).success).toBe(false);
});
