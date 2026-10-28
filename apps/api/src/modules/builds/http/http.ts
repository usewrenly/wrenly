/**
 * Build HTTP admission, status and event subscriptions.
 * Authenticates and bounds requests, then delegates to saved-work services.
 * Closing a progress stream closes observation only; cancellation requires its separate authorized action.
 */
import { SkillError } from "../../skills/skill-contract";
import { AccessDeniedError } from "../../auth/access/access-policy";
import { z } from "zod";
import { BuildAdmissionError } from "../admission/build-admission";
import type {
  BuildSnapshot,
  SavedBuildEvent,
} from "../persistence/build-queries";
import { logger } from "../../../lib/logger";

const ID_SCHEMA = z.string().uuid();
const POLL_INTERVAL_MS = 1000;
const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
const TERMINAL_OUTCOMES = new Set([
  "success",
  "failed",
  "interrupted",
  "cancelled",
]);

export interface BuildHttpDependencies {
  userId: (headers: Headers) => Promise<string | null>;
  admit: (
    body: unknown,
    userId: string,
    key: string,
  ) => Promise<{ buildId: string; replayed: boolean }>;
  snapshot: (id: string, userId: string) => Promise<BuildSnapshot | null>;
  events: (
    id: string,
    userId: string,
    after: number,
  ) => Promise<SavedBuildEvent[]>;
  cancel: (id: string, userId: string) => Promise<boolean>;
}
export interface BuildHttpHandlers {
  activity: (request: Request, id: string) => Promise<Response>;
  create: (request: Request) => Promise<Response>;
  get: (request: Request, id: string) => Promise<Response>;
  events: (request: Request, id: string) => Promise<Response>;
  cancel: (request: Request, id: string) => Promise<Response>;
}

function unavailable(error: unknown): Response {
  if (error instanceof AccessDeniedError)
    return Response.json({ error: error.message }, { status: 401 });
  logger.error("Build HTTP operation unavailable", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return Response.json(
    {
      error:
        "Build state is temporarily unavailable. Check the API and database.",
    },
    { status: 503 },
  );
}

/** Prepares the durable HTTP contract without starting a worker or mounting routes. */
export function createBuildHttpHandlers(
  dependencies: BuildHttpDependencies,
): BuildHttpHandlers {
  const authorize = async (
    request: Request,
    id: string,
  ): Promise<string | Response> => {
    try {
      const userId = await dependencies.userId(request.headers);
      if (!userId)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (!ID_SCHEMA.safeParse(id).success)
        return Response.json(
          { error: "Build ID must be a UUID." },
          { status: 400 },
        );
      return userId;
    } catch (error) {
      return unavailable(error);
    }
  };
  return {
    create: async (request) => {
      try {
        const userId = await dependencies.userId(request.headers);
        if (!userId)
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: "Request body must be valid JSON." },
            { status: 400 },
          );
        }
        const result = await dependencies.admit(
          body,
          userId,
          request.headers.get("Idempotency-Key") ?? "",
        );
        return Response.json(result, {
          status: result.replayed ? 200 : 202,
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) {
        if (error instanceof SkillError)
          return Response.json(
            { error: error.message },
            { status: error.status },
          );
        if (error instanceof BuildAdmissionError)
          return Response.json(
            { error: error.message },
            { status: error.status },
          );
        return unavailable(error);
      }
    },
    get: async (request, id) => {
      const userId = await authorize(request, id);
      if (userId instanceof Response) return userId;
      try {
        const snapshot = await dependencies.snapshot(id, userId);
        return snapshot
          ? Response.json(snapshot, {
              headers: { "Cache-Control": "no-store" },
            })
          : Response.json({ error: "Build not found" }, { status: 404 });
      } catch (error) {
        return unavailable(error);
      }
    },
    activity: async (request, id) => {
      const userId = await authorize(request, id);
      if (userId instanceof Response) return userId;
      try {
        const snapshot = await dependencies.snapshot(id, userId);
        return snapshot
          ? Response.json(
              {
                buildId: snapshot.build.id,
                cursor: snapshot.cursor,
                outcome: snapshot.outcome,
                activity: snapshot.activity ?? [],
              },
              { headers: { "Cache-Control": "no-store" } },
            )
          : Response.json({ error: "Build not found" }, { status: 404 });
      } catch (error) {
        return unavailable(error);
      }
    },
    cancel: async (request, id) => {
      const userId = await authorize(request, id);
      if (userId instanceof Response) return userId;
      try {
        const found = await dependencies.cancel(id, userId);
        return found
          ? Response.json({ cancellationRequested: true })
          : Response.json({ error: "Build not found" }, { status: 404 });
      } catch (error) {
        return unavailable(error);
      }
    },
    events: async (request, id) => {
      const userId = await authorize(request, id);
      if (userId instanceof Response) return userId;
      const query = new URL(request.url).searchParams.get("after");
      const header = request.headers.get("Last-Event-ID");
      const rawCursor = query ?? header ?? "0";
      const cursor = Number(rawCursor);
      if (!/^\d+$/.test(rawCursor) || !Number.isSafeInteger(cursor))
        return Response.json(
          { error: "Invalid event cursor." },
          { status: 400 },
        );
      try {
        const initial = await dependencies.snapshot(id, userId);
        if (!initial?.outcome)
          return Response.json(
            { error: "Build stream not found" },
            { status: 404 },
          );
        if (cursor > initial.cursor)
          return Response.json(
            { error: "Event cursor is ahead of this build." },
            { status: 400 },
          );
        let after = cursor;
        let stopped = false;
        let wake: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = (): void => {
          stopped = true;
          if (timer) clearTimeout(timer);
          wake?.();
          request.signal.removeEventListener("abort", stop);
        };
        request.signal.addEventListener("abort", stop, { once: true });
        if (request.signal.aborted) stop();
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async pull(controller): Promise<void> {
            try {
              while (!stopped) {
                if ((await dependencies.userId(request.headers)) !== userId)
                  throw new Error("Access revoked");
                const snapshot = await dependencies.snapshot(id, userId);
                if (!snapshot?.outcome)
                  throw new Error("Build access is no longer available.");
                const events = await dependencies.events(id, userId, after);
                if (stopped) {
                  controller.close();
                  return;
                }
                for (const event of events) {
                  if (event.sequence !== after + 1)
                    throw new Error("Build event history has a gap.");
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
                if (events.length) return;
                if (
                  TERMINAL_OUTCOMES.has(snapshot.outcome) &&
                  after === snapshot.cursor
                ) {
                  stop();
                  controller.close();
                  return;
                }
                controller.enqueue(encoder.encode(": heartbeat\n\n"));
                await new Promise<void>((resolve) => {
                  wake = resolve;
                  timer = setTimeout(resolve, POLL_INTERVAL_MS);
                });
                wake = undefined;
                timer = undefined;
                return;
              }
              controller.close();
            } catch (error) {
              if (!stopped) {
                logger.error("Build event subscription failed", {
                  buildId: id,
                  errorName:
                    error instanceof Error ? error.name : "UnknownError",
                });
                stop();
                controller.error(
                  new Error(
                    "Build progress connection failed. Reconnect to read saved state.",
                  ),
                );
              }
            }
          },
          cancel(): void {
            stop();
          },
        });
        return new Response(stream, { headers: SSE_HEADERS });
      } catch (error) {
        return unavailable(error);
      }
    },
  };
}
