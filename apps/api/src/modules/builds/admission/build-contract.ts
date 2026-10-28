/**
 * Build request validation shared by HTTP and saved-work admission.
 * A new prompt, explicit retry and follow-up revision have different rules.
 * Publishing is a separate action; rejecting deploy:true prevents generation from triggering a remote deployment.
 */
import { z } from "zod";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
export const GenerateRequestSchema = z
  .object({
    prompt: z.string().min(1).max(10_000).optional(),
    projectId: z.string().uuid(),
    stack: z.enum(["nextjs", "laravel", "vue", "django"]).optional(),
    model: z.string().min(1).max(512).optional(),
    provider: z.string().min(1).max(100).optional(),
    previousBuildId: z.string().uuid().optional(),
    retryBuildId: z.string().uuid().optional(),
    database: BuildDatabaseSelection.optional(),
    deploy: z.boolean().default(false),
  })
  .superRefine((input, context) => {
    if (input.deploy)
      context.addIssue({
        code: "custom",
        path: ["deploy"],
        message:
          "Publishing is a separate action. Build first, then publish the saved revision.",
      });
    if (!input.retryBuildId && !input.prompt)
      context.addIssue({
        code: "custom",
        path: ["prompt"],
        message: "A prompt is required for a new build.",
      });
    if (
      input.retryBuildId &&
      (input.prompt !== undefined ||
        input.stack !== undefined ||
        input.model !== undefined ||
        input.provider !== undefined ||
        input.previousBuildId !== undefined ||
        input.deploy ||
        input.database !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["retryBuildId"],
        message:
          "Retry uses saved settings. Send only projectId and retryBuildId.",
      });
    }
  });
