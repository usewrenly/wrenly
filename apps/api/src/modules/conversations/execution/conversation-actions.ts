/**
 * Turning an allowed proposal into one saved build.
 * Assistant proposal, action link and durable build admission commit together using server-owned actor/settings/source/skills.
 * Later reconciliation reads the existing build result instead of repeating inference or admission.
 */
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  conversations,
  conversationTurns,
  conversationActions,
  conversationMessages,
  projects,
  builds,
  buildJobs,
} from "../../../../../../packages/db/src/schema";
import {
  admitBuild,
  type AdmissionDependencies,
} from "../../builds/admission/build-admission";
import { validateConversationDecision } from "../contracts/contracts";
import {
  lockConversationClaim,
  appendConversationEvent,
  ConversationStoreError,
  type ConversationClaim,
  type ConversationTransaction,
  type ConversationTurn,
} from "../persistence/conversation-store";
import { logger } from "../../../lib/logger";

async function saveProposal(
  transaction: ConversationTransaction,
  turn: ConversationTurn,
  content: string,
): Promise<void> {
  try {
    const [conversation] = await transaction
      .select()
      .from(conversations)
      .where(eq(conversations.id, turn.conversationId))
      .for("update");
    if (!conversation) throw new Error("Conversation unavailable.");
    await transaction
      .insert(conversationMessages)
      .values({
        conversationId: turn.conversationId,
        turnId: turn.id,
        sequence: conversation.nextMessageSequence,
        role: "assistant",
        kind: "propose_build",
        content,
      });
    await transaction
      .update(conversations)
      .set({ nextMessageSequence: conversation.nextMessageSequence + 1 })
      .where(eq(conversations.id, turn.conversationId));
  } catch (error) {
    throw new Error("The assistant proposal could not be saved.", {
      cause: error,
    });
  }
}

/** Commits the assistant proposal, action and existing durable build admission as one transaction. */
export async function admitConversationBuildAction(
  database: typeof db,
  claim: ConversationClaim,
  value: unknown,
  settings: Pick<
    AdmissionDependencies,
    "resolveProvider" | "defaultModel" | "resolveSelection"
  >,
): Promise<string> {
  try {
    return await database.transaction(async (transaction) => {
      const turn = await lockConversationClaim(transaction, claim);
      const decision = validateConversationDecision(value, turn.mode);
      if (decision.type !== "propose_build")
        throw new ConversationStoreError(
          400,
          "This decision does not propose a build.",
        );
      const [owned] = await transaction
        .select({ project: projects })
        .from(conversations)
        .innerJoin(projects, eq(projects.id, conversations.projectId))
        .where(eq(conversations.id, turn.conversationId));
      if (!owned) throw new ConversationStoreError(404, "Project not found");
      if (!turn.baseBuildId) {
        const [existingSource] = await transaction
          .select({ id: builds.id })
          .from(builds)
          .where(
            and(
              eq(builds.projectId, owned.project.id),
              isNotNull(builds.files),
            ),
          )
          .limit(1);
        if (existingSource)
          throw new ConversationStoreError(
            409,
            "Select the revision to change before starting another build.",
          );
      }
      // The model cannot choose IDs, credentials, stack or settings; use frozen server-owned input.
      const admitted = await admitBuild(
        {
          projectId: owned.project.id,
          prompt: decision.prompt,
          model: turn.model,
          provider: turn.provider,
          stack: owned.project.stack,
          ...(turn.baseBuildId ? { previousBuildId: turn.baseBuildId } : {}),
        },
        turn.actorId,
        crypto.randomUUID(),
        { ...settings, db: database, transaction, frozenSkills: turn.skillsV1, databaseSelection: turn.databaseV1 ?? undefined },
      );
      await saveProposal(transaction, turn, decision.content);
      await transaction
        .insert(conversationActions)
        .values({ turnId: turn.id, buildId: admitted.buildId });
      await transaction
        .update(conversationTurns)
        .set({
          status: "waiting_build",
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(conversationTurns.id, turn.id));
      await appendConversationEvent(transaction, turn, "tool_call", {
        action: "build",
        buildId: admitted.buildId,
        baseBuildId: turn.baseBuildId,
        status: "waiting_build",
      });
      return admitted.buildId;
    });
  } catch (error) {
    logger.error("Conversation build action failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

/** Reconciles an already-admitted build after reconnect/restart without rerunning inference or admission. */
export async function reconcileConversationBuild(
  database: typeof db,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      const [saved] = await transaction
        .select({
          turn: conversationTurns,
          buildId: builds.id,
          outcome: buildJobs.status,
          attempt: builds.attemptCount,
        })
        .from(conversationTurns)
        .innerJoin(
          conversationActions,
          eq(conversationActions.turnId, conversationTurns.id),
        )
        .innerJoin(
          buildJobs,
          eq(buildJobs.buildId, conversationActions.buildId),
        )
        .innerJoin(builds, eq(builds.id, buildJobs.buildId))
        .where(
          and(
            eq(conversationTurns.status, "waiting_build"),
            inArray(buildJobs.status, [
              "success",
              "failed",
              "interrupted",
              "cancelled",
            ]),
          ),
        )
        .orderBy(asc(conversationTurns.createdAt))
        .limit(1)
        .for("update", { of: conversationTurns, skipLocked: true });
      if (!saved) return false;
      const status =
        saved.outcome === "success"
          ? "completed"
          : saved.outcome === "interrupted"
            ? "interrupted"
            : saved.outcome === "cancelled"
              ? "cancelled"
              : "failed";
      const error =
        status === "completed"
          ? null
          : "The linked build did not succeed. Review its saved result, source and diagnostics.";
      await transaction
        .update(conversationTurns)
        .set({ status, errorMessage: error, completedAt: new Date() })
        .where(eq(conversationTurns.id, saved.turn.id));
      await appendConversationEvent(transaction, saved.turn, "tool_result", {
        action: "build",
        buildId: saved.buildId,
        outcome: saved.outcome,
        attempt: saved.attempt,
      });
      await appendConversationEvent(
        transaction,
        { ...saved.turn, nextEventSequence: saved.turn.nextEventSequence + 1 },
        "complete",
        {
          status,
          buildId: saved.buildId,
          outcome: saved.outcome,
        },
      );
      return true;
    });
  } catch (error) {
    logger.error("Conversation build reconciliation failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}
