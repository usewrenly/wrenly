/**
 * One saved build’s generation and validation attempts.
 * Calls the framework MCP tool, saves generated source, validates it in Docker and feeds errors into bounded repair attempts.
 * Persistence or cleanup failures stop execution rather than masquerading as model mistakes.
 */
import { z } from "zod";
import type { AgentInput, AgentOutput, FileTree } from "../../mcp/agent-client";
import type { SandboxOutput } from "@wrenly/sandbox";
import type {
  BuildClaim,
  BuildOutcome,
  BuildProgress,
} from "../persistence/build-job-store";
import { buildPreviousFilesContext } from "./source-context";
import { logger } from "../../../lib/logger";
import { McpCleanupError } from "../../mcp/mcp-generation";
import { BuildExecutionInterruptedError } from "./build-interruption";
import { databaseBuildGuidance } from "../../databases/validation/build-guidance";
import { validateLaravelSource } from "../../../../../../packages/sandbox/src/source-policy/laravel-runtime";

const MAX_ATTEMPTS = 3;
const MAX_REPAIR_ERROR_CHARS = 6000;
const MAX_DIAGNOSTIC_CHARS = 256_000;
const FilesSchema = z
  .array(z.object({ path: z.string().min(1), content: z.string() }))
  .min(1)
  .max(1000);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface BuildExecutorDependencies {
  generate: (
    stack: string,
    input: AgentInput,
    signal: AbortSignal,
  ) => Promise<AgentOutput>;
  validate: (
    files: FileTree,
    claim: BuildClaim,
    signal: AbortSignal,
    attempt: number,
  ) => Promise<SandboxOutput>;
  streamsValidationLogs?: boolean;
  progress: (claim: BuildClaim, progress: BuildProgress) => Promise<void>;
}

function validateFiles(value: unknown, stack: string): FileTree {
  const files = FilesSchema.parse(value);
  const required =
    stack === "laravel"
      ? "composer.json"
      : stack === "django"
        ? "requirements.txt"
        : "package.json";
  if (!files.some((file) => file.path === required))
    throw new Error(`Generated source is missing ${required}.`);
  if (Buffer.byteLength(JSON.stringify(files)) > MAX_SOURCE_BYTES)
    throw new Error("Generated source exceeds the build artifact limits.");
  if (stack === "laravel") validateLaravelSource(files);
  return files;
}

function abortIfRequested(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Build aborted.");
}

/** Executes saved inputs only; persistence errors escape rather than being treated as model errors. */
export async function executeClaimedBuild(
  claim: BuildClaim,
  signal: AbortSignal,
  dependencies: BuildExecutorDependencies,
): Promise<BuildOutcome> {
  const input = claim.input;
  const databaseGuidance = databaseBuildGuidance(input.stack, input.databaseV1);
  const previousErrors = [...input.previousErrors];
  let source = input.previousFiles;
  let lastError = "Build did not complete.";
  const diagnostics = async (
    attempt: number,
    message: string,
  ): Promise<void> => {
    try {
      await dependencies.progress(claim, {
        type: "log_line",
        attempt,
        line: message.slice(-MAX_DIAGNOSTIC_CHARS),
      });
    } catch (error) {
      throw new Error("Build diagnostic persistence failed.", { cause: error });
    }
  };
  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      abortIfRequested(signal);
      await dependencies.progress(claim, {
        type: "status",
        attempt,
        phase: "generating",
        message: `Generating your app... (attempt ${attempt} of ${MAX_ATTEMPTS})`,
      });
      await dependencies.progress(claim, {
        type: "activity_v1",
        attempt,
        operation: "generation",
        state: "started",
      });
      const editing =
        ["nextjs", "laravel"].includes(input.stack) && source.length > 0;
      const context = editing ? "" : buildPreviousFilesContext(source);
      let files: FileTree;
      try {
        const output = await dependencies.generate(
          input.stack,
          {
            buildId: claim.buildId,
            skills_v1: input.skillsV1,
            ...(editing ? { previousFiles: source } : {}),
            prompt: [context ? `${context}\nNew request: ${input.prompt}` : input.prompt,
              databaseGuidance ? `Wrenly managed database context:\n${databaseGuidance}` : ""].filter(Boolean).join("\n\n"),
            model: input.model,
            provider: input.provider,
            previousErrors: [...previousErrors],
            attempt,
          },
          signal,
        );
        abortIfRequested(signal);
        files = validateFiles(output.files, input.stack);
      } catch (error) {
        abortIfRequested(signal);
        if (error instanceof McpCleanupError) throw error;
        await dependencies.progress(claim, {
          type: "activity_v1",
          attempt,
          operation: "generation",
          state: "failed",
        });
        lastError =
          error instanceof Error
            ? error.message.slice(-MAX_REPAIR_ERROR_CHARS)
            : "MCP generation failed.";
        await diagnostics(
          attempt,
          `Attempt ${attempt}: Generation failed: ${lastError}`,
        );
        previousErrors.push(
          `Generation failed: ${lastError}\nReturn valid structured source files, without prose or code fences.`,
        );
        continue;
      }
      abortIfRequested(signal);
      await dependencies.progress(claim, {
        type: "activity_v1",
        attempt,
        operation: "generation",
        state: "completed",
      });
      await dependencies.progress(claim, {
        type: "activity_v1",
        attempt,
        operation: "source",
        state: "completed",
      });
      await dependencies.progress(claim, { type: "file_tree", attempt, files });
      await dependencies.progress(claim, {
        type: "status",
        attempt,
        phase: "building",
        message: "Building in sandbox...",
      });
      let result: SandboxOutput;
      try {
        result = await dependencies.validate(files, claim, signal, attempt);
      } catch (error) {
        abortIfRequested(signal);
        // An unexpected adapter failure may leave resources behind. Do not launch
        // another attempt until the scheduler has confirmed cleanup.
        if (error instanceof BuildExecutionInterruptedError) throw error;
        throw new Error("Sandbox execution could not be completed safely.", {
          cause: error,
        });
      }
      await diagnostics(
        attempt,
        [
          `Attempt ${attempt}: Sandbox ${result.success ? "succeeded" : "failed"}`,
          dependencies.streamsValidationLogs ? undefined : result.output,
          result.error,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (result.success) return { status: "success" };
      abortIfRequested(signal);
      source = files;
      lastError = [result.error, result.output]
        .filter(Boolean)
        .join("\n")
        .slice(-MAX_REPAIR_ERROR_CHARS);
      previousErrors.push(lastError || "Sandbox validation failed.");
      if (attempt < MAX_ATTEMPTS)
        await dependencies.progress(claim, {
          type: "status",
          attempt,
          phase: "retrying",
          message: "Validation failed — retrying with fixes...",
        });
    }
    return {
      status: "failed",
      error: `Build failed after ${MAX_ATTEMPTS} attempts. ${lastError}`,
    };
  } catch (error) {
    // Do not log provider/source details contained in operation errors.
    if (!signal.aborted)
      logger.error("Claimed build execution stopped", {
        buildId: claim.buildId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    throw error;
  }
}
