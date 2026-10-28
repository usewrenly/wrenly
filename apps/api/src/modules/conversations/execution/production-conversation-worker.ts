/**
 * Connecting conversation workers to real server services.
 * Resolves the frozen provider, uses shared safe inference transport and separates answers from build actions.
 * Independently follows already-admitted build results; startup/shutdown are explicit.
 */
import { createInferenceFetch } from "@wrenly/inference";
import { resolve } from "node:path";
import {
  resolveInferenceSelection,
  resolveExecutionProvider,
} from "../../models/selection/saved-providers";
import type { db } from "@wrenly/db";
import { eq } from "drizzle-orm";
import {
  conversations,
  conversationMessages,
  conversationTurns,
  conversationEvents,
  conversationActions,
  conversationQueue,
} from "../../../../../../packages/db/src/schema";
import {
  claimConversationTurn,
  renewConversationLease,
  interruptExpiredConversationTurn,
  completeConversationAnswer,
  failConversationTurn,
} from "../persistence/conversation-store";
import {
  admitConversationBuildAction,
  reconcileConversationBuild,
} from "./conversation-actions";
import { loadConversationContext } from "./conversation-context";
import {
  inferConversationDecision,
  ConversationModelError,
} from "./conversation-model";
import { runConversationWorker } from "./conversation-worker";
import { logger } from "../../../lib/logger";
import { getProvider } from "../../models/environment/providers";

const RECONCILE_INTERVAL_MS = 1000;

/** Fails clearly before serving conversation requests; never migrates operator data automatically. */
export async function verifyConversationSchema(
  database: typeof db,
): Promise<void> {
  try {
    await database
      .select({ id: conversations.id })
      .from(conversations)
      .limit(1);
    await database
      .select({ id: conversationTurns.id, actorId: conversationTurns.actorId, databaseV1: conversationTurns.databaseV1 })
      .from(conversationTurns)
      .limit(1);
    await database
      .select({
        id: conversationMessages.id,
        actorId: conversationMessages.actorId,
      })
      .from(conversationMessages)
      .limit(1);
    await database
      .select({ sequence: conversationEvents.sequence })
      .from(conversationEvents)
      .limit(1);
    await database
      .select({ id: conversationActions.id })
      .from(conversationActions)
      .limit(1);
    await database
      .select({ id: conversationQueue.id })
      .from(conversationQueue)
      .limit(1);
    // PostgreSQL validates the enum literal even when no Plan turns exist.
    await database
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(eq(conversationTurns.mode, "plan"))
      .limit(1);
  } catch {
    throw new Error(
      "Conversation persistence requires migrations through 0035. Check PostgreSQL and run bun run db:migrate from packages/db before starting the API.",
    );
  }
}

/** Starts bounded conversation inference and saved build reconciliation after explicit startup; caller must await stop on shutdown. */
export async function startProductionConversationWorker(
  database: typeof db,
  timeoutSeconds: number,
): Promise<{ done: Promise<void>; stop: () => Promise<void> }> {
  try {
    await verifyConversationSchema(database);
    const shutdown = new AbortController();
    const done = runConversationWorker(
      {
        claim: () => claimConversationTurn(database),
        renew: (claim) => renewConversationLease(database, claim),
        recover: async () =>
          (await reconcileConversationBuild(database)) ||
          (await interruptExpiredConversationTurn(database)),
        context: (claim) => loadConversationContext(database, claim),
        infer: async (claim, context, signal) => {
          let provider;
          try {
            provider = await resolveExecutionProvider(
              database,
              claim.input.provider,
              resolve(process.env.WRENLY_DATA_DIR ?? ".local/wrenly"),
            );
          } catch {
            throw new ConversationModelError(
              "The selected provider is no longer configured. Select another provider and submit a new message.",
            );
          }
          return inferConversationDecision(
            { context, model: claim.input.model, mode: claim.input.mode },
            provider,
            signal,
            createInferenceFetch({
              baseUrl: provider.baseUrl,
              kind: provider.networkScope ?? provider.kind,
              timeoutMs: timeoutSeconds * 1000,
            }),
          );
        },
        complete: async (claim, decision) => {
          if (decision.type === "propose_build")
            await admitConversationBuildAction(database, claim, decision, {
              resolveProvider: getProvider,
              resolveSelection: (provider, model, transaction) =>
                resolveInferenceSelection(transaction, provider, model),
              defaultModel: claim.input.model,
            });
          else await completeConversationAnswer(database, claim, decision);
        },
        fail: (claim, status, message) =>
          failConversationTurn(database, claim, status, message),
      },
      shutdown.signal,
      timeoutSeconds * 1000,
    );
    let reconciliation: Promise<void> | undefined;
    const reconcile = (): void => {
      if (shutdown.signal.aborted || reconciliation) return;
      reconciliation = (async (): Promise<void> => {
        while (
          !shutdown.signal.aborted &&
          (await reconcileConversationBuild(database))
        ) {
          /* Existing jobs only. */
        }
      })()
        .catch((error) => {
          logger.error("Conversation result polling failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
        })
        .finally(() => {
          reconciliation = undefined;
        });
    };
    const timer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
    return {
      done,
      stop: async () => {
        shutdown.abort();
        clearInterval(timer);
        await Promise.all([done, reconciliation]);
      },
    };
  } catch {
    throw new Error(
      "Conversation worker could not start. Check PostgreSQL and migration 0005.",
    );
  }
}
