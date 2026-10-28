/**
 * Conversation input and decision rules.
 * A submitted message selects Auto or Plan and may produce an answer, clarification or build proposal.
 * These validators enforce allowed actions independently of model instructions; saved historical modes remain readable without changing the current composer.
 */
import { z } from "zod";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";

export const MAX_MESSAGE_CHARS = 16_000;
export const ConversationRequestSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
    mode: z.enum(["auto", "ask", "build", "plan"]).default("auto"),
    baseBuildId: z.string().uuid().nullable().default(null),
    model: z.string().trim().min(1).max(512).optional(),
    database: BuildDatabaseSelection.optional(),
    provider: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const ContentSchema = z.string().trim().min(1).max(MAX_MESSAGE_CHARS);
export const ConversationDecisionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer"), content: ContentSchema }).strict(),
  z.object({ type: z.literal("clarify"), content: ContentSchema }).strict(),
  z
    .object({
      type: z.literal("propose_build"),
      content: ContentSchema,
      prompt: z.string().trim().min(1).max(10_000),
    })
    .strict(),
]);
export type ConversationMode = z.infer<
  typeof ConversationRequestSchema
>["mode"];
export type ConversationDecision = z.infer<typeof ConversationDecisionSchema>;

/** Enforces the user's mode independently of the model's proposed operation. */
export function validateConversationDecision(
  value: unknown,
  mode: ConversationMode,
): ConversationDecision {
  const decision = ConversationDecisionSchema.parse(value);
  if ((mode === "ask" || mode === "plan") && decision.type === "propose_build")
    throw new Error(
      `${mode === "plan" ? "Plan" : "Ask"} mode cannot start a build.`,
    );
  if (mode === "build" && decision.type === "answer")
    throw new Error("Build mode requires a build proposal or clarification.");
  return decision;
}
