/**
 * Remembering conversation requests, messages and progress.
 * Admission freezes actor, selected revision, model and skills with a unique request identity before work.
 * Worker claims/leases fence writes, history reads check current access and interrupted work is never silently sent to the model again.
 */
import { parseSkillGuidance, type SkillGuidance } from "@wrenly/inference";
import { freezeProjectSkills } from "../../skills/project-skills";
import { AppDatabaseError } from "../../databases/database-contract";
import { freezeBuildDatabaseSelection } from "../../databases/bindings/build-selection";
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { hasDatabaseWork } from "../../databases/database-activity";
import {
  getProjectAuthors,
  type ProjectAuthor,
} from "../../projects/http/project-authors";
import {
  unarchivedProjectPredicate,
  readableProjectPredicate,
  readProjectCapabilities,
  requireProjectCapability,
  ProjectAccessError,
} from "../../projects/access/project-access";
import {
  resolveProjectModelSelection,
  ProjectModelError,
} from "../../projects/sharing/project-model";
import { assertActiveAccount } from "../../auth/access/access-policy";
import { and, asc, count, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import {
  projects,
  builds,
  conversations,
  conversationQueue,
  conversationTurns,
  conversationMessages,
  conversationEvents,
  conversationActions,
} from "../../../../../../packages/db/src/schema";
import {
  ConversationRequestSchema,
  validateConversationDecision,
} from "../contracts/contracts";
import { requestBuildCancellation } from "../../builds/persistence/build-job-store";
import { logger } from "../../../lib/logger";

const QUEUE_LOCK_ID = 1;
const MAX_ACTIVE_TURNS = 20;
const MAX_CONVERSATION_TURNS = 1000;
const MAX_HISTORY_PAGE = 100;
const MAX_TURN_ERROR_CHARS = 1000;
const TURN_LEASE_MS = 30_000;
const ACTIVE_STATUSES = ["queued", "running", "waiting_build"] as const;
const UuidSchema = z.string().uuid();
type Database = typeof db;
export type ConversationTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type ConversationTurn = typeof conversationTurns.$inferSelect;
type Transaction = ConversationTransaction;
type Turn = ConversationTurn;

export class ConversationStoreError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "ConversationStoreError";
  }
}
export interface ConversationAdmissionDependencies {
  db: Database;
  defaultModel: string;
  /** Enabled only by complete database host composition, never by a model decision. */
  allowDatabaseSelection?: boolean;
  resolveSelection?: (
    provider: string | undefined,
    model: string | undefined,
    database: ConversationTransaction,
  ) => Promise<{ provider: string; model: string }>;
  resolveProvider: (id: string | undefined) => { id: string };
}
export interface ConversationClaim {
  turnId: string;
  token: string;
  input: Pick<
    Turn,
    "conversationId" | "prompt" | "mode" | "baseBuildId" | "model" | "provider"
  > & { skillsV1?: SkillGuidance; databaseV1?: BuildDatabaseSelection };
}

function logFailure(operation: string, error: unknown): void {
  if (!(error instanceof ConversationStoreError))
    logger.error("Conversation persistence failed", {
      operation,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
}
async function lockQueue(transaction: Transaction): Promise<void> {
  try {
    await transaction
      .insert(conversationQueue)
      .values({ id: QUEUE_LOCK_ID })
      .onConflictDoNothing();
    await transaction
      .select()
      .from(conversationQueue)
      .where(eq(conversationQueue.id, QUEUE_LOCK_ID))
      .for("update");
  } catch (error) {
    logFailure("lock queue", error);
    throw error;
  }
}
/** Appends an ordered event inside the transaction holding its turn lock. */
export async function appendConversationEvent(
  transaction: Transaction,
  turn: Turn,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await transaction
      .insert(conversationEvents)
      .values({
        turnId: turn.id,
        sequence: turn.nextEventSequence,
        type,
        data,
      });
    await transaction
      .update(conversationTurns)
      .set({ nextEventSequence: turn.nextEventSequence + 1 })
      .where(eq(conversationTurns.id, turn.id));
  } catch (error) {
    logFailure("append event", error);
    throw error;
  }
}
/** Locks and checks the current lease before any decision writes or action admission. */
export async function lockConversationClaim(
  transaction: Transaction,
  claim: ConversationClaim,
): Promise<Turn> {
  try {
    const [turn] = await transaction
      .select()
      .from(conversationTurns)
      .where(eq(conversationTurns.id, claim.turnId))
      .for("update");
    if (
      !turn ||
      turn.status !== "running" ||
      turn.claimToken !== claim.token ||
      !turn.leaseExpiresAt ||
      turn.leaseExpiresAt.getTime() <= Date.now()
    )
      throw new ConversationStoreError(
        409,
        "Conversation execution no longer owns a valid lease.",
      );
    return turn;
  } catch (error) {
    logFailure("lock claim", error);
    throw error;
  }
}

/** Persists a message and immutable execution settings once, without calling a model. */
export async function admitConversationTurn(
  projectId: string,
  userId: string,
  key: string,
  body: unknown,
  dependencies: ConversationAdmissionDependencies,
): Promise<{ turnId: string; conversationId: string; replayed: boolean }> {
  const parsed = ConversationRequestSchema.safeParse(body);
  if (
    !parsed.success ||
    !UuidSchema.safeParse(projectId).success ||
    !UuidSchema.safeParse(key).success
  )
    throw new ConversationStoreError(
      400,
      "Provide a valid message, project and UUID idempotency key.",
    );
  const input = parsed.data;
  const identity = JSON.stringify(input);
  try {
    return await dependencies.db.transaction(async (transaction) => {
      await lockQueue(transaction);
      await assertActiveAccount(transaction, userId);
      try {
        await requireProjectCapability(
          transaction,
          projectId,
          userId,
          "contribute",
        );
      } catch (error) {
        if (error instanceof ProjectAccessError)
          throw new ConversationStoreError(error.status, error.message);
        throw error;
      }
      const [project] = await transaction
        .select()
        .from(projects)
        .where(eq(projects.id, projectId));
      if (!project) throw new ConversationStoreError(404, "Project not found");
      let [conversation] = await transaction
        .select()
        .from(conversations)
        .where(eq(conversations.projectId, projectId));
      if (conversation) {
        const [existing] = await transaction
          .select()
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.conversationId, conversation.id),
              eq(conversationTurns.actorId, userId),
              eq(conversationTurns.idempotencyKey, key),
            ),
          );
        if (existing) {
          if (existing.requestIdentity !== identity)
            throw new ConversationStoreError(
              409,
              "This idempotency key was already used for another message.",
            );
          return {
            turnId: existing.id,
            conversationId: conversation.id,
            replayed: true,
          };
        }
        if (conversation.turnCount >= MAX_CONVERSATION_TURNS)
          throw new ConversationStoreError(
            429,
            "Conversation history is full. Archival is required before adding messages.",
          );
        const [active] = await transaction
          .select({ id: conversationTurns.id })
          .from(conversationTurns)
          .where(
            and(
              eq(conversationTurns.conversationId, conversation.id),
              inArray(conversationTurns.status, [...ACTIVE_STATUSES]),
            ),
          )
          .limit(1);
        if (active)
          throw new ConversationStoreError(
            409,
            "This project already has an active conversation turn.",
          );
      }
      if (input.database !== undefined && !dependencies.allowDatabaseSelection)
        throw new ConversationStoreError(409, "Database-backed conversations are not enabled on this instance yet.");
      if (await hasDatabaseWork(transaction, projectId))
        throw new ConversationStoreError(
          409,
          "Finish or reconcile the database operation before continuing the conversation.",
        );
      const [capacity] = await transaction
        .select({ total: count() })
        .from(conversationTurns)
        .where(inArray(conversationTurns.status, [...ACTIVE_STATUSES]));
      if ((capacity?.total ?? 0) >= MAX_ACTIVE_TURNS)
        throw new ConversationStoreError(
          429,
          "The conversation queue is full. Try again after a turn finishes.",
        );
      if (input.baseBuildId) {
        const [base] = await transaction
          .select()
          .from(builds)
          .where(
            and(
              eq(builds.id, input.baseBuildId),
              eq(builds.projectId, projectId),
            ),
          );
        if (!base)
          throw new ConversationStoreError(404, "Selected revision not found");
        if (base.status !== "success" && base.status !== "failed")
          throw new ConversationStoreError(
            409,
            "The selected revision is still in progress.",
          );
      }
      let provider: string, model: string;
      try {
        const selected = await resolveProjectModelSelection(
          transaction,
          project,
          userId,
          input,
          async (requestedProvider, requestedModel) =>
            dependencies.resolveSelection
              ? dependencies.resolveSelection(
                  requestedProvider,
                  requestedModel,
                  transaction,
                )
              : {
                  provider: dependencies.resolveProvider(requestedProvider).id,
                  model: requestedModel ?? dependencies.defaultModel,
                },
        );
        provider = selected.provider;
        model = selected.model;
      } catch (error) {
        throw new ConversationStoreError(
          400,
          error instanceof ProjectModelError && error.status === 400
            ? error.message
            : "The selected model provider is unavailable.",
        );
      }
      if (!conversation) {
        [conversation] = await transaction
          .insert(conversations)
          .values({ projectId })
          .returning();
      }
      if (!conversation)
        throw new Error("Conversation insertion returned no record.");
      let databaseV1: BuildDatabaseSelection | undefined;
      try { databaseV1 = await freezeBuildDatabaseSelection(transaction, projectId, userId, project.stack, input.database); }
      catch (error) {
        if (error instanceof AppDatabaseError) throw new ConversationStoreError(409, error.message);
        throw error;
      }
      const skillsV1 = {
        version: 1 as const,
        skills: await freezeProjectSkills(transaction, projectId),
      };
      const turnId = crypto.randomUUID();
      await transaction
        .insert(conversationTurns)
        .values({
          id: turnId,
          conversationId: conversation.id,
          actorId: userId,
          idempotencyKey: key,
          requestIdentity: identity,
          prompt: input.message,
          mode: input.mode,
          baseBuildId: input.baseBuildId,
          model,
          provider,
          skillsV1,
          databaseV1: databaseV1 ?? null,
        });
      await transaction
        .insert(conversationMessages)
        .values({
          conversationId: conversation.id,
          turnId,
          sequence: conversation.nextMessageSequence,
          actorId: userId,
          role: "user",
          kind: "message",
          content: input.message,
        });
      await transaction
        .update(conversations)
        .set({
          nextMessageSequence: conversation.nextMessageSequence + 1,
          turnCount: conversation.turnCount + 1,
        })
        .where(eq(conversations.id, conversation.id));
      await transaction
        .insert(conversationEvents)
        .values({
          turnId,
          sequence: 1,
          type: "status",
          data: { status: "queued" },
        });
      return { turnId, conversationId: conversation.id, replayed: false };
    });
  } catch (error) {
    logFailure("admit turn", error);
    throw error;
  }
}

export interface ConversationTurnSummary {
  database?: BuildDatabaseSelection;
  actorId?: string;
  skillsUsed?: Array<{ name: string; versionId: string; sha256: string }>;
  id: string;
  status: Turn["status"];
  mode: Turn["mode"];
  baseBuildId: string | null;
  buildId: string | null;
  errorMessage: string | null;
  model: string;
  provider: string;
}
const TurnSummarySelection = {
  databaseV1: conversationTurns.databaseV1,
  skillsV1: conversationTurns.skillsV1,
  actorId: conversationTurns.actorId,
  id: conversationTurns.id,
  status: conversationTurns.status,
  mode: conversationTurns.mode,
  baseBuildId: conversationTurns.baseBuildId,
  errorMessage: conversationTurns.errorMessage,
  model: conversationTurns.model,
  provider: conversationTurns.provider,
  buildId: conversationActions.buildId,
};

function publicTurn(
  turn: ConversationTurnSummary & { skillsV1?: SkillGuidance; databaseV1?: BuildDatabaseSelection | null },
): ConversationTurnSummary {
  const { skillsV1, databaseV1, ...visible } = turn;
  return {
    ...visible,
    ...(databaseV1 ? { database: BuildDatabaseSelection.parse(databaseV1) } : {}),
    skillsUsed: parseSkillGuidance(skillsV1).skills.map(
      ({ name, versionId, sha256 }) => ({ name, versionId, sha256 }),
    ),
  };
}

/** Returns owned messages in stable cursor order; never invents messages from old builds. */
export async function getConversationHistory(
  database: Database,
  projectId: string,
  userId: string,
  after = 0,
  limit = 50,
): Promise<{
  conversationId: string | null;
  messages: Array<
    typeof conversationMessages.$inferSelect & { author: ProjectAuthor | null }
  >;
  nextCursor: number | null;
  latestTurn: ConversationTurnSummary | null;
  turns: ConversationTurnSummary[];
}> {
  if (
    !UuidSchema.safeParse(projectId).success ||
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_HISTORY_PAGE
  )
    throw new ConversationStoreError(
      400,
      "Provide a valid history cursor and a page size from 1 to 100.",
    );
  try {
    const [project] = await database
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, projectId),
          readableProjectPredicate(database, userId),
        ),
      );
    if (!project) throw new ConversationStoreError(404, "Project not found");
    const [conversation] = await database
      .select()
      .from(conversations)
      .where(eq(conversations.projectId, projectId));
    if (!conversation)
      return {
        conversationId: null,
        messages: [],
        nextCursor: null,
        latestTurn: null,
        turns: [],
      };
    const rows = await database
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.conversationId, conversation.id),
          gt(conversationMessages.sequence, after),
        ),
      )
      .orderBy(asc(conversationMessages.sequence))
      .limit(limit + 1);
    const [latestTurn] = await database
      .select(TurnSummarySelection)
      .from(conversationMessages)
      .innerJoin(
        conversationTurns,
        eq(conversationTurns.id, conversationMessages.turnId),
      )
      .leftJoin(
        conversationActions,
        eq(conversationActions.turnId, conversationTurns.id),
      )
      .where(
        and(
          eq(conversationMessages.conversationId, conversation.id),
          eq(conversationMessages.role, "user"),
        ),
      )
      .orderBy(desc(conversationMessages.sequence))
      .limit(1);
    const authors = await getProjectAuthors(
      database,
      rows.flatMap((row) => (row.actorId ? [row.actorId] : [])),
    );
    const messages = rows
      .slice(0, limit)
      .map((row) => ({
        ...row,
        author: row.actorId ? (authors.get(row.actorId) ?? null) : null,
      }));
    const turnIds = [...new Set(messages.map((message) => message.turnId))];
    const turns = turnIds.length
      ? await database
          .select(TurnSummarySelection)
          .from(conversationTurns)
          .leftJoin(
            conversationActions,
            eq(conversationActions.turnId, conversationTurns.id),
          )
          .where(
            and(
              eq(conversationTurns.conversationId, conversation.id),
              inArray(conversationTurns.id, turnIds),
            ),
          )
      : [];
    return {
      conversationId: conversation.id,
      messages,
      nextCursor:
        rows.length > limit ? (messages.at(-1)?.sequence ?? null) : null,
      latestTurn: latestTurn ? publicTurn(latestTurn) : null,
      turns: turns.map(publicTurn),
    };
  } catch (error) {
    logFailure("read history", error);
    throw error;
  }
}

/** Claims queued inference once; expired work is explicitly interrupted, never rerun. */
export async function claimConversationTurn(
  database: Database,
): Promise<ConversationClaim | null> {
  try {
    return await database.transaction(async (transaction) => {
      await lockQueue(transaction);
      const [turn] = await transaction
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.status, "queued"),
            inArray(
              conversationTurns.conversationId,
              transaction
                .select({ id: conversations.id })
                .from(conversations)
                .where(
                  unarchivedProjectPredicate(
                    transaction,
                    conversations.projectId,
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(conversationTurns.createdAt), asc(conversationTurns.id))
        .limit(1)
        .for("update");
      if (!turn) return null;
      const token = crypto.randomUUID();
      await transaction
        .update(conversationTurns)
        .set({
          status: "running",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + TURN_LEASE_MS),
        })
        .where(eq(conversationTurns.id, turn.id));
      await appendConversationEvent(transaction, turn, "status", {
        status: "running",
      });
      return {
        turnId: turn.id,
        token,
        input: {
          conversationId: turn.conversationId,
          prompt: turn.prompt,
          mode: turn.mode,
          baseBuildId: turn.baseBuildId,
          model: turn.model,
          provider: turn.provider,
          skillsV1: turn.skillsV1,
          ...(turn.databaseV1 ? { databaseV1: turn.databaseV1 } : {}),
        },
      };
    });
  } catch (error) {
    logFailure("claim turn", error);
    throw error;
  }
}

/** Keeps a currently owned inference lease alive without reviving an expired executor. */
export async function renewConversationLease(
  database: Database,
  claim: ConversationClaim,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      await lockConversationClaim(transaction, claim);
      await transaction
        .update(conversationTurns)
        .set({ leaseExpiresAt: new Date(Date.now() + TURN_LEASE_MS) })
        .where(eq(conversationTurns.id, claim.turnId));
      return true;
    });
  } catch (error) {
    if (error instanceof ConversationStoreError && error.status === 409)
      return false;
    logFailure("renew lease", error);
    throw error;
  }
}

/** Saves only validated model answers/clarifications; build proposals need atomic action admission. */
export async function completeConversationAnswer(
  database: Database,
  claim: ConversationClaim,
  value: unknown,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const turn = await lockConversationClaim(transaction, claim);
      const decision = validateConversationDecision(value, turn.mode);
      if (decision.type === "propose_build")
        throw new ConversationStoreError(
          409,
          "Build proposals require action admission, not answer completion.",
        );
      const [conversation] = await transaction
        .select()
        .from(conversations)
        .where(eq(conversations.id, turn.conversationId))
        .for("update");
      if (!conversation) throw new Error("Conversation no longer exists.");
      await transaction
        .insert(conversationMessages)
        .values({
          conversationId: conversation.id,
          turnId: turn.id,
          sequence: conversation.nextMessageSequence,
          role: "assistant",
          kind: decision.type,
          content: decision.content,
        });
      await transaction
        .update(conversations)
        .set({ nextMessageSequence: conversation.nextMessageSequence + 1 })
        .where(eq(conversations.id, conversation.id));
      await transaction
        .update(conversationTurns)
        .set({
          status: "completed",
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(conversationTurns.id, turn.id));
      await appendConversationEvent(transaction, turn, "complete", {
        status: "completed",
        kind: decision.type,
      });
    });
  } catch (error) {
    logFailure("complete answer", error);
    throw error;
  }
}

/** Records one expired inference as interrupted without executing or fabricating an answer. */
export async function interruptExpiredConversationTurn(
  database: Database,
): Promise<boolean> {
  try {
    return await database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(conversationTurns)
        .where(
          and(
            eq(conversationTurns.status, "running"),
            lte(conversationTurns.leaseExpiresAt, new Date()),
          ),
        )
        .orderBy(asc(conversationTurns.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!turn) return false;
      const error =
        "Conversation execution was interrupted. Retry explicitly after reviewing its saved activity.";
      await transaction
        .update(conversationTurns)
        .set({
          status: "interrupted",
          errorMessage: error,
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(conversationTurns.id, turn.id));
      await appendConversationEvent(transaction, turn, "complete", {
        status: "interrupted",
        error,
      });
      return true;
    });
  } catch (error) {
    logFailure("recover expired turn", error);
    throw error;
  }
}

export interface ConversationTurnSnapshot {
  id: string;
  conversationId: string;
  mode: Turn["mode"];
  baseBuildId: string | null;
  status: Turn["status"];
  errorMessage: string | null;
  cursor: number;
  events: Array<typeof conversationEvents.$inferSelect>;
  nextCursor: number | null;
  buildId?: string | null;
}

/** Reads an owned turn and bounded replay without exposing claim tokens or internal settings. */
export async function getConversationTurnSnapshot(
  database: Database,
  turnId: string,
  userId: string,
  after = 0,
): Promise<ConversationTurnSnapshot> {
  if (
    !UuidSchema.safeParse(turnId).success ||
    !Number.isSafeInteger(after) ||
    after < 0
  )
    throw new ConversationStoreError(
      400,
      "Provide a valid conversation turn and event cursor.",
    );
  try {
    const [owned] = await database
      .select({ turn: conversationTurns })
      .from(conversationTurns)
      .innerJoin(
        conversations,
        eq(conversations.id, conversationTurns.conversationId),
      )
      .innerJoin(projects, eq(projects.id, conversations.projectId))
      .where(
        and(
          eq(conversationTurns.id, turnId),
          readableProjectPredicate(database, userId),
        ),
      );
    if (!owned)
      throw new ConversationStoreError(404, "Conversation turn not found");
    const turn = owned.turn;
    const [action] = await database
      .select({ buildId: conversationActions.buildId })
      .from(conversationActions)
      .where(eq(conversationActions.turnId, turn.id));
    const cursor = turn.nextEventSequence - 1;
    const rows = await database
      .select()
      .from(conversationEvents)
      .where(
        and(
          eq(conversationEvents.turnId, turnId),
          gt(conversationEvents.sequence, after),
          lte(conversationEvents.sequence, cursor),
        ),
      )
      .orderBy(asc(conversationEvents.sequence))
      .limit(MAX_HISTORY_PAGE + 1);
    const events = rows.slice(0, MAX_HISTORY_PAGE);
    return {
      id: turn.id,
      conversationId: turn.conversationId,
      mode: turn.mode,
      baseBuildId: turn.baseBuildId,
      status: turn.status,
      errorMessage: turn.errorMessage,
      cursor,
      events,
      buildId: action?.buildId ?? null,
      nextCursor:
        rows.length > MAX_HISTORY_PAGE
          ? (events.at(-1)?.sequence ?? null)
          : null,
    };
  } catch (error) {
    logFailure("read turn", error);
    throw error;
  }
}

export type ConversationFailureStatus = "failed" | "interrupted";

/** Persists a safe failure under the active claim, preserving the user's original message. */
export async function failConversationTurn(
  database: Database,
  claim: ConversationClaim,
  status: ConversationFailureStatus,
  message: string,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      const turn = await lockConversationClaim(transaction, claim);
      await transaction
        .update(conversationTurns)
        .set({
          status,
          errorMessage: message.slice(0, MAX_TURN_ERROR_CHARS),
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(conversationTurns.id, turn.id));
      await appendConversationEvent(transaction, turn, "complete", {
        status,
        error: message.slice(0, MAX_TURN_ERROR_CHARS),
      });
    });
  } catch (error) {
    logFailure("fail turn", error);
    throw error;
  }
}

/** Cancels inference by fencing its claim; subscriber disconnect never calls this operation. */
export async function cancelConversationTurn(
  database: Database,
  turnId: string,
  userId: string,
): Promise<boolean> {
  if (!UuidSchema.safeParse(turnId).success)
    throw new ConversationStoreError(
      400,
      "Provide a valid conversation turn ID.",
    );
  try {
    return await database.transaction(async (transaction) => {
      const [turn] = await transaction
        .select()
        .from(conversationTurns)
        .where(eq(conversationTurns.id, turnId))
        .for("update");
      if (!turn) return false;
      const [owned] = await transaction
        .select({ id: conversations.id })
        .from(conversations)
        .innerJoin(projects, eq(projects.id, conversations.projectId))
        .where(
          and(
            eq(conversations.id, turn.conversationId),
            readableProjectPredicate(database, userId),
          ),
        );
      if (!owned) return false;
      const [container] = await transaction
        .select({ projectId: conversations.projectId })
        .from(conversations)
        .where(eq(conversations.id, turn.conversationId));
      const permission = container
        ? await readProjectCapabilities(
            transaction,
            container.projectId,
            userId,
          )
        : null;
      if (
        !permission?.contribute ||
        (permission.role !== "owner" && turn.actorId !== userId)
      )
        return false;
      if (turn.status === "waiting_build") {
        const [action] = await transaction
          .select()
          .from(conversationActions)
          .where(eq(conversationActions.turnId, turnId));
        if (!action)
          throw new ConversationStoreError(
            409,
            "The linked build action is unavailable.",
          );
        return await requestBuildCancellation(database, action.buildId, userId);
      }
      if (turn.status !== "queued" && turn.status !== "running") return true;
      await transaction
        .update(conversationTurns)
        .set({
          status: "cancelled",
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(conversationTurns.id, turnId));
      await appendConversationEvent(transaction, turn, "complete", {
        status: "cancelled",
      });
      return true;
    });
  } catch (error) {
    logFailure("cancel turn", error);
    throw error;
  }
}
