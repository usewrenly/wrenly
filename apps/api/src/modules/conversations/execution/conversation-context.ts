/**
 * Evidence supplied when asking the model to respond.
 * Loads only the revision selected at submission and history through that message.
 * Source filenames and bounded diagnostics are labelled honestly; missing/truncated evidence must not become invented code inspection.
 */
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { parseSkillGuidance, type SkillGuidance } from "@wrenly/inference";
import { and, asc, eq, lte } from "drizzle-orm";
import type { db } from "@wrenly/db";
import {
  builds,
  buildJobs,
  conversations,
  conversationMessages,
  projects,
} from "../../../../../../packages/db/src/schema";
import type { ConversationClaim } from "../persistence/conversation-store";

const MAX_CONTEXT_CHARS = 64_000;
const MAX_HISTORY_MESSAGES = 200;
const MAX_DIAGNOSTIC_CHARS = 12_000;
const MAX_FILE_MANIFEST_CHARS = 12_000;
export interface ConversationContext {
  skillsV1?: SkillGuidance;
  developmentDatabaseSelected?: true;
  project: { name: string; stack: string };
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  revision: null | {
    id: string;
    status: string;
    outcome: string | null;
    attemptCount: number;
    error: string | null;
    diagnostics: string | null;
    diagnosticsOmitted: boolean;
    fileManifest: string[];
    manifestOmitted: boolean;
  };
}

export class ConversationContextError extends Error {
  constructor() {
    super(
      "The saved conversation exceeds the supported context budget. No model request was sent.",
    );
    this.name = "ConversationContextError";
  }
}

/** Loads only the submitted revision; labels bounded evidence rather than pretending it is complete. */
export async function loadConversationContext(
  database: typeof db,
  claim: ConversationClaim,
): Promise<ConversationContext> {
  try {
    const [conversation] = await database
      .select({ project: projects })
      .from(conversations)
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(eq(conversations.id, claim.input.conversationId));
    if (!conversation) throw new Error("Conversation project unavailable.");
    const [submitted] = await database
      .select({ sequence: conversationMessages.sequence })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.turnId, claim.turnId),
          eq(conversationMessages.role, "user"),
        ),
      );
    if (!submitted) throw new Error("Submitted message unavailable.");
    const history = await database
      .select({
        role: conversationMessages.role,
        content: conversationMessages.content,
      })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, claim.input.conversationId),
          lte(conversationMessages.sequence, submitted.sequence),
        ),
      )
      .orderBy(asc(conversationMessages.sequence))
      .limit(MAX_HISTORY_MESSAGES + 1);
    if (history.length > MAX_HISTORY_MESSAGES)
      throw new ConversationContextError();
    let revision: ConversationContext["revision"] = null;
    if (claim.input.baseBuildId) {
      const [saved] = await database
        .select({ build: builds, outcome: buildJobs.status })
        .from(builds)
        .leftJoin(buildJobs, eq(buildJobs.buildId, builds.id))
        .where(
          and(
            eq(builds.id, claim.input.baseBuildId),
            eq(builds.projectId, conversation.project.id),
          ),
        );
      if (!saved) throw new Error("Selected revision unavailable.");
      const files = Array.isArray(saved.build.files) ? saved.build.files : [];
      const fileManifest: string[] = [];
      let manifestChars = 0;
      for (const file of files) {
        if (
          !file ||
          typeof file !== "object" ||
          !("path" in file) ||
          typeof file.path !== "string"
        )
          continue;
        if (manifestChars + file.path.length > MAX_FILE_MANIFEST_CHARS) break;
        fileManifest.push(file.path);
        manifestChars += file.path.length;
      }
      const diagnostics = saved.build.buildLog;
      revision = {
        id: saved.build.id,
        status: saved.build.status,
        outcome: saved.outcome,
        attemptCount: saved.build.attemptCount,
        error: saved.build.errorMessage?.slice(0, MAX_DIAGNOSTIC_CHARS) ?? null,
        diagnostics: diagnostics?.slice(-MAX_DIAGNOSTIC_CHARS) ?? null,
        diagnosticsOmitted:
          (diagnostics?.length ?? 0) > MAX_DIAGNOSTIC_CHARS ||
          (saved.build.errorMessage?.length ?? 0) > MAX_DIAGNOSTIC_CHARS,
        fileManifest,
        manifestOmitted: fileManifest.length !== files.length,
      };
    }
    const context: ConversationContext = {
      skillsV1: parseSkillGuidance(claim.input.skillsV1),
      ...(claim.input.databaseV1 && BuildDatabaseSelection.parse(claim.input.databaseV1) ? { developmentDatabaseSelected: true as const } : {}),
      project: {
        name: conversation.project.name,
        stack: conversation.project.stack,
      },
      messages: history,
      revision,
    };
    if (JSON.stringify(context).length > MAX_CONTEXT_CHARS)
      throw new ConversationContextError();
    return context;
  } catch (error) {
    throw error instanceof ConversationContextError
      ? error
      : new Error("Saved conversation context is unavailable.", {
          cause: error,
        });
  }
}
