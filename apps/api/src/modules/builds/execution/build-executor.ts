import { assertRevisionBudget } from "@wrenly/source-control/revision";
import { isSourceAsset, REVISION_LIMITS, type SourceAsset } from "@wrenly/source-control/revision";
import {
  parseAttachmentSnapshot,
  type AttachmentSnapshot,
  type AttachmentWireContent,
} from "@wrenly/inference";
import {
  parseFrameworkInspectionReport,
  frameworkSourceHash,
  type FrameworkInspectionReport,
} from "@wrenly/inference/framework-tooling";
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
  .array(z.object({ path: z.string().min(1), content: z.string(), asset: z.custom<SourceAsset>(isSourceAsset).optional() }))
  .min(1)
  .max(REVISION_LIMITS.files);
const MAX_SOURCE_BYTES = REVISION_LIMITS.serializedBytes;

export interface BuildExecutorDependencies {
  resolveAttachments?: (
    snapshot: AttachmentSnapshot,
    signal: AbortSignal,
  ) => Promise<AttachmentWireContent>;
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
  assertRevisionBudget(files);
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
  const attachmentSnapshot = parseAttachmentSnapshot(input.attachmentsV1);
  if (attachmentSnapshot.files.length && !dependencies.resolveAttachments)
    throw new Error(
      "Saved reference files are unavailable. No attachment was dropped.",
    );
  const attachments = attachmentSnapshot.files.length
    ? await dependencies.resolveAttachments!(attachmentSnapshot, signal)
    : undefined;
  const previousErrors = [...input.previousErrors];
  let source = input.previousFiles;
  let inspection: FrameworkInspectionReport | undefined;
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
    // Imported source is an exact remote revision, not an instruction to regenerate it.
    // A failed check preserves that source; repair requires a separate explicit prompt.
    if (input.sourceValidationV1 !== undefined) {
      abortIfRequested(signal);
      if (
        input.sourceValidationV1.version !== 1 ||
        !/^[a-f0-9]{40}$/.test(input.sourceValidationV1.commitId) ||
        !["nextjs", "laravel"].includes(input.stack) ||
        input.databaseV1 !== undefined
      )
        throw new Error("Imported source validation settings could not be verified.");
      const files = validateFiles(input.previousFiles, input.stack);
      await dependencies.progress(claim, { type: "file_tree", attempt: 1, files });
      await dependencies.progress(claim, {
        type: "activity_v1", attempt: 1, operation: "source", state: "completed",
      });
      await dependencies.progress(claim, {
        type: "status", attempt: 1, phase: "building",
        message: "Validating the imported revision in Docker…",
      });
      const result = await dependencies.validate(files, claim, signal, 1);
      await diagnostics(1, [
        "Imported revision validation",
        dependencies.streamsValidationLogs ? undefined : result.output,
        result.error,
      ].filter(Boolean).join("\n"));
      if (result.success) return { status: "success" };
      abortIfRequested(signal);
      const detail = [result.error, result.output].filter(Boolean)
        .join("\n").slice(-MAX_REPAIR_ERROR_CHARS);
      return {
        status: "failed",
        error: `Imported source failed validation. Its files were preserved without model changes. ${detail}`,
      };
    }
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
            ...(attachments ? { attachments_v1: attachments } : {}),
            ...(editing ? { previousFiles: source } : {}),
            prompt: [
              context
                ? `${context}\nNew request: ${input.prompt}`
                : input.prompt,
              databaseGuidance
                ? `Wrenly managed database context:\n${databaseGuidance}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
            model: input.model,
            provider: input.provider,
            ...(inspection ? { framework_inspection_v1: inspection } : {}),
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
      inspection = result.frameworkInspection
        ? parseFrameworkInspectionReport(result.frameworkInspection)
        : undefined;
      if (
        inspection &&
        (inspection.sourceHash !== frameworkSourceHash(files) ||
          inspection.framework !== input.stack)
      )
        throw new Error(
          "Framework inspection does not match this build attempt.",
        );
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
