/** Saves proposals and owner decisions; neither reading nor approving performs external work. */
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  conversationDatabaseWorkflows as workflows,
  conversationTurns,
  conversations,
  conversationMessages,
  projects,
  appDatabases,
  builds,
  type db,
} from "@wrenly/db";
import {
  lockConversationClaim,
  appendConversationEvent,
  ConversationStoreError,
  type ConversationClaim,
} from "../persistence/conversation-store";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
} from "../../databases/database-store";
import {
  requireProjectCapability,
  readProjectCapabilities,
} from "../../projects/access/project-access";
import { accessContext } from "../../auth/access/access-context";
import { z } from "zod";
import { DatabaseWorkflowCards } from "@wrenly/db/conversation-workflow";
import type { ConversationDecision } from "../contracts/contracts";
import { validateConversationDecision } from "../contracts/contracts";

export const APPROVAL_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const WorkflowDecision = z
  .object({
    revision: z.string().uuid(),
    decision: z.enum(["approve", "decline", "stop"]),
  })
  .strict();
export type Workflow = typeof workflows.$inferSelect;
export const RUNNING_WORKFLOW_STATES = [
  "setup",
  "building",
  "waiting_build",
  "backup",
  "migrating",
] as const;
export const MAX_WORKFLOWS_PER_PROJECT = 100;

/** Model instructions cannot select a resource, grant owner authority or start provisioning. */
export async function saveDatabaseProposal(
  database: typeof db,
  claim: ConversationClaim,
  decision: ConversationDecision,
): Promise<void> {
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx, { wait: true });
    const [scope] = await tx
      .select({ projectId: conversations.projectId })
      .from(conversations)
      .where(eq(conversations.id, claim.input.conversationId));
    if (!scope) throw new ConversationStoreError(404, "Project not found.");
    const [actor] = await tx
      .select({ id: conversationTurns.actorId })
      .from(conversationTurns)
      .where(eq(conversationTurns.id, claim.turnId));
    if (!actor)
      throw new ConversationStoreError(404, "Conversation not found.");
    await requireProjectCapability(tx, scope.projectId, actor.id, "contribute");
    const turn = await lockConversationClaim(tx, claim);
    const checked = validateConversationDecision(decision, turn.mode);
    if (checked.type !== "propose_database" && checked.type !== "propose_build")
      throw new ConversationStoreError(
        400,
        "This response does not propose an application.",
      );
    const [parent] = await tx
      .select({ conversation: conversations, project: projects })
      .from(conversations)
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(eq(conversations.id, turn.conversationId))
      .for("update");
    if (!parent) throw new ConversationStoreError(404, "Project not found.");
    if (!turn.baseBuildId) {
      const [saved] = await tx
        .select({ id: builds.id })
        .from(builds)
        .where(eq(builds.projectId, parent.project.id))
        .limit(1);
      if (saved)
        throw new ConversationStoreError(
          409,
          "Select the revision to change before requesting database setup.",
        );
    }
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.projectId, parent.project.id),
          eq(appDatabases.environment, "development"),
        ),
      );
    if (
      turn.databaseV1 &&
      (turn.databaseV1.resourceId !== resource?.id ||
        turn.databaseV1.resourceRevision !== resource?.revision)
    )
      throw new ConversationStoreError(
        409,
        "The selected database changed. Review its current state before sending again.",
      );
    const existing = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.projectId, parent.project.id))
      .limit(MAX_WORKFLOWS_PER_PROJECT);
    if (existing.length >= MAX_WORKFLOWS_PER_PROJECT)
      throw new ConversationStoreError(
        409,
        "This project has reached its database workflow history limit.",
      );
    await tx.insert(workflows).values({
      turnId: turn.id,
      projectId: parent.project.id,
      accessRevision: parent.project.accessRevision,
      prompt: checked.prompt,
      purpose: checked.content,
      resourceId: resource?.id ?? null,
      resourceRevision: resource?.revision ?? null,
    });
    await tx.insert(conversationMessages).values({
      conversationId: parent.conversation.id,
      turnId: turn.id,
      sequence: parent.conversation.nextMessageSequence,
      role: "assistant",
      kind: "propose_database",
      content: checked.content,
    });
    await tx
      .update(conversations)
      .set({ nextMessageSequence: parent.conversation.nextMessageSequence + 1 })
      .where(eq(conversations.id, parent.conversation.id));
    await tx
      .update(conversationTurns)
      .set({
        status: "completed",
        completedAt: new Date(),
        claimToken: null,
        leaseExpiresAt: null,
      })
      .where(eq(conversationTurns.id, turn.id));
    await appendConversationEvent(tx, turn, "complete", {
      status: "completed",
      kind: "propose_database",
    });
  });
}
/** Exposes only safe card data after current project authorization; session authority never leaves the server. */
export async function readDatabaseWorkflows(
  database: typeof db,
  projectId: string,
  actorId: string,
): Promise<DatabaseWorkflowCards> {
  const access = await readProjectCapabilities(database, projectId, actorId);
  if (!access) throw new ConversationStoreError(404, "Project not found.");
  const rows = await database
    .select()
    .from(workflows)
    .where(eq(workflows.projectId, projectId))
    .orderBy(asc(workflows.createdAt))
    .limit(MAX_WORKFLOWS_PER_PROJECT);
  const current = await readProjectCapabilities(database, projectId, actorId);
  if (!current || current.role !== access.role)
    throw new ConversationStoreError(403, "Project access changed.");
  return DatabaseWorkflowCards.parse({
    canManage: current.manage,
    workflows: rows.map((row) => ({
      id: row.id,
      turnId: row.turnId,
      revision: row.revision,
      state: row.state,
      purpose: row.purpose.slice(0, 2000),
      resourceId: row.resourceId,
      buildId: row.buildId,
      error: row.error,
      framework:
        row.state === "review" ? (row.review?.framework ?? null) : null,
      files: row.state === "review" ? (row.review?.files ?? []) : [],
    })),
  });
}

/** Exact revision checks make a repeated approval an observation of the saved decision. */
export async function approveDatabaseWorkflow(
  database: typeof db,
  projectId: string,
  actorId: string,
  id: string,
  body: unknown,
): Promise<void> {
  const input = WorkflowDecision.parse(body);
  await database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await requireProjectCapability(tx, projectId, actorId, "manage");
    const [row] = await tx
      .select()
      .from(workflows)
      .where(and(eq(workflows.id, id), eq(workflows.projectId, projectId)))
      .for("update");
    if (!row)
      throw new ConversationStoreError(404, "Database proposal not found.");
    // A saved revision is also the decision identity: a lost response must not approve the next phase.
    if (row.revision !== input.revision)
      throw new ConversationStoreError(
        409,
        "The proposal changed. Reload its current card before approving.",
      );
    if (
      input.decision === "stop" &&
      RUNNING_WORKFLOW_STATES.includes(
        row.state as (typeof RUNNING_WORKFLOW_STATES)[number],
      )
    ) {
      await tx
        .update(workflows)
        .set({
          state: "cancelled",
          revision: crypto.randomUUID(),
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, id));
      return;
    }
    if (!["proposed", "review"].includes(row.state)) return;
    if (input.decision === "stop")
      throw new ConversationStoreError(409, "This workflow is not running.");
    const principal = accessContext.getStore()?.principal;
    if (!principal || principal.userId !== actorId)
      throw new ConversationStoreError(
        403,
        "Sign in again before approving database work.",
      );
    const [project] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, projectId));
    const [turn] = await tx
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, row.turnId));
    if (
      !project ||
      project.accessRevision !== row.accessRevision ||
      turn?.actorId !== actorId
    )
      throw new ConversationStoreError(
        409,
        "The project or submitting account changed. Send a new request as the project owner.",
      );
    if (input.decision === "decline") {
      await tx
        .update(workflows)
        .set({ state: "declined", updatedAt: new Date() })
        .where(eq(workflows.id, id));
      return;
    }
    await requireDatabaseProjectIdle(tx, projectId);
    const [busy] = await tx
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.projectId, projectId),
          ne(workflows.id, id),
          inArray(workflows.state, [...RUNNING_WORKFLOW_STATES, "review"]),
        ),
      )
      .limit(1);
    if (busy)
      throw new ConversationStoreError(
        409,
        "Finish the existing database workflow first.",
      );
    const [resource] = await tx
      .select()
      .from(appDatabases)
      .where(
        and(
          eq(appDatabases.projectId, projectId),
          eq(appDatabases.environment, "development"),
        ),
      );
    if (
      (resource?.id ?? null) !== row.resourceId ||
      (resource?.revision ?? null) !== row.resourceRevision ||
      (resource && resource.status !== "ready")
    )
      throw new ConversationStoreError(
        409,
        "The database changed. Send a fresh request using its current state.",
      );
    await tx
      .update(workflows)
      .set({
        principal,
        expiresAt: new Date(Date.now() + APPROVAL_LIFETIME_MS),
        updatedAt: new Date(),
        state:
          row.state === "review" ? "backup" : resource ? "building" : "setup",
        operation:
          row.state === "review"
            ? {
                requestId: crypto.randomUUID(),
                kind: "backup",
                environment: "development",
                expectedRevision: resource!.revision,
              }
            : resource
              ? null
              : {
                  requestId: crypto.randomUUID(),
                  kind: "create",
                  environment: "development",
                  expectedRevision: null,
                },
      })
      .where(eq(workflows.id, id));
  });
}
