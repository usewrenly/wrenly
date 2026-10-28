/**
 * Conversation HTTP admission, history and progress.
 * Authenticates before bounded input, uses explicit request/revision identity and rechecks reads.
 * Closing an event stream stops observation only; cancellation has its own authorized endpoint.
 */
import { SkillError } from "../../skills/skill-contract";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { z } from "zod";
import { ConversationRequestSchema } from "../contracts/contracts";
import {
  ConversationStoreError,
  type ConversationTurnSnapshot,
} from "../persistence/conversation-store";
import { logger } from "../../../lib/logger";

class ConversationAuthenticationError extends Error {}

const ID_SCHEMA = z.string().uuid();
const MAX_REQUEST_BYTES = 96_000;
const BODY_DEADLINE_MS = 5000;
const POLL_INTERVAL_MS = 1000;
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);
const PRIVATE_HEADERS = { "Cache-Control": "no-store" };
export interface ConversationHttpDependencies {
  userId: (headers: Headers) => Promise<string | null>;
  admit: (
    projectId: string,
    userId: string,
    key: string,
    body: unknown,
  ) => Promise<{ turnId: string; conversationId: string; replayed: boolean }>;
  history: (
    projectId: string,
    userId: string,
    after: number,
    limit: number,
  ) => Promise<unknown>;
  snapshot: (
    id: string,
    userId: string,
    after: number,
  ) => Promise<ConversationTurnSnapshot>;
  cancel: (id: string, userId: string) => Promise<boolean>;
}
export interface ConversationHttpHandlers {
  create: (request: Request, projectId: string) => Promise<Response>;
  history: (request: Request, projectId: string) => Promise<Response>;
  get: (request: Request, id: string) => Promise<Response>;
  events: (request: Request, id: string) => Promise<Response>;
  cancel: (request: Request, id: string) => Promise<Response>;
}
function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}
function failure(error: unknown): Response {
  if (error instanceof AccessDeniedError)
    return json({ error: error.message }, 401);
  if (error instanceof SkillError)
    return json({ error: error.message }, error.status);
  if (error instanceof ConversationStoreError)
    return json({ error: error.message }, error.status);
  logger.error("Conversation HTTP operation failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return json(
    {
      error:
        "Conversation state is temporarily unavailable. Check the API and database.",
    },
    503,
  );
}
function cursor(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
    throw new ConversationStoreError(
      400,
      "Provide a valid conversation cursor or page size.",
    );
  return Number(raw);
}
async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader)
    throw new ConversationStoreError(400, "Request body must be valid JSON.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    let size = 0;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const interrupted = new Promise<never>((_, reject) => {
      abort = () =>
        reject(
          new ConversationStoreError(
            400,
            "The message request was interrupted.",
          ),
        );
      request.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () =>
          reject(
            new ConversationStoreError(
              400,
              "The message body took too long to arrive.",
            ),
          ),
        BODY_DEADLINE_MS,
      );
      if (request.signal.aborted) abort();
    });
    while (true) {
      const chunk = await Promise.race([reader.read(), interrupted]);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_REQUEST_BYTES)
        throw new ConversationStoreError(
          400,
          "The message request is too large.",
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof SkillError)
      return json({ error: error.message }, error.status);
    if (error instanceof ConversationStoreError) throw error;
    throw new ConversationStoreError(400, "Request body must be valid JSON.");
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Creates owned conversation routes; validated actions execute independently of subscriptions. */
export function createConversationHttpHandlers(
  dependencies: ConversationHttpDependencies,
): ConversationHttpHandlers {
  const authorize = async (request: Request, id: string): Promise<string> => {
    const userId = await dependencies.userId(request.headers);
    if (!userId) throw new ConversationAuthenticationError();
    if (!ID_SCHEMA.safeParse(id).success)
      throw new ConversationStoreError(
        400,
        "Provide a valid project or turn UUID.",
      );
    return userId;
  };
  // Authentication is handled outside the store's 400/404 domain errors.
  const authorized = async (
    request: Request,
    id: string,
    operation: (userId: string) => Promise<Response>,
  ): Promise<Response> => {
    try {
      const userId = await authorize(request, id);
      return await operation(userId);
    } catch (error) {
      if (error instanceof ConversationAuthenticationError)
        return json({ error: "Unauthorized" }, 401);
      return failure(error);
    }
  };
  return {
    create: (request, projectId) =>
      authorized(request, projectId, async (userId) => {
        const parsed = ConversationRequestSchema.safeParse(
          await readBody(request),
        );
        if (!parsed.success)
          return json({ error: "Provide valid message settings." }, 400);
        const result = await dependencies.admit(
          projectId,
          userId,
          request.headers.get("Idempotency-Key") ?? "",
          parsed.data,
        );
        return json(result, result.replayed ? 200 : 202);
      }),
    history: (request, projectId) =>
      authorized(request, projectId, async (userId) => {
        const query = new URL(request.url).searchParams;
        return json(
          await dependencies.history(
            projectId,
            userId,
            cursor(query.get("after"), 0),
            cursor(query.get("limit"), 50),
          ),
        );
      }),
    get: (request, id) =>
      authorized(request, id, async (userId) =>
        json(
          await dependencies.snapshot(
            id,
            userId,
            cursor(new URL(request.url).searchParams.get("after"), 0),
          ),
        ),
      ),
    cancel: (request, id) =>
      authorized(request, id, async (userId) => {
        return (await dependencies.cancel(id, userId))
          ? json({ cancellationRequested: true })
          : json({ error: "Conversation turn not found" }, 404);
      }),
    events: (request, id) =>
      authorized(request, id, async (userId) => {
        let after = cursor(
          new URL(request.url).searchParams.get("after") ??
            request.headers.get("Last-Event-ID"),
          0,
        );
        const initial = await dependencies.snapshot(id, userId, after);
        if (after > initial.cursor)
          return json(
            { error: "Event cursor is ahead of this conversation turn." },
            400,
          );
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let wake: (() => void) | undefined;
        const stop = (): void => {
          stopped = true;
          if (timer) clearTimeout(timer);
          wake?.();
          request.signal.removeEventListener("abort", stop);
        };
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller): Promise<void> {
              try {
                if (stopped) {
                  controller.close();
                  return;
                }
                if ((await dependencies.userId(request.headers)) !== userId)
                  throw new Error("Access revoked");
                const snapshot = await dependencies.snapshot(id, userId, after);
                if (stopped) {
                  controller.close();
                  return;
                }
                for (const event of snapshot.events) {
                  if (event.sequence !== after + 1)
                    throw new Error("Conversation event history has a gap.");
                  controller.enqueue(
                    encoder.encode(
                      `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
                    ),
                  );
                  after = event.sequence;
                  if (event.type === "complete") {
                    stop();
                    controller.close();
                    return;
                  }
                }
                if (
                  TERMINAL.has(snapshot.status) &&
                  after === snapshot.cursor
                ) {
                  stop();
                  controller.close();
                  return;
                }
                if (snapshot.events.length) return;
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  timer = setTimeout(resolve, POLL_INTERVAL_MS);
                });
                wake = undefined;
                timer = undefined;
              } catch (error) {
                if (!stopped) {
                  stop();
                  logger.error("Conversation subscription failed", {
                    errorName:
                      error instanceof Error ? error.name : "UnknownError",
                  });
                  controller.error(
                    new Error(
                      "Conversation progress disconnected. Reconnect to read saved state.",
                    ),
                  );
                }
              }
            },
            cancel(): void {
              stop();
            },
          }),
          {
            headers: {
              ...PRIVATE_HEADERS,
              "Content-Type": "text/event-stream; charset=utf-8",
              "X-Accel-Buffering": "no",
              Connection: "keep-alive",
            },
          },
        );
      }),
  };
}
