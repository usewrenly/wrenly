/**
 * Deployment HTTP boundary.
 * Production composition supplies authenticated identity and durable stores.
 * Validates bounded inputs and returns safe status data; never executes publishing from a browser request.
 */
import { AccessDeniedError } from "../../auth/access/access-policy";

import { z } from "zod";
import { DeploymentStoreError } from "../persistence/deployment-store";
const RequestSchema = z.object({ buildId: z.string().uuid() }).strict();
const UUID = z.string().uuid();
const MAX_BODY_BYTES = 1024;
const BODY_TIMEOUT_MS = 5000;
export interface DeploymentHttpDependencies {
  list?: (userId: string, offset: number) => Promise<unknown>;
  enabled: boolean;
  userId: (headers: Headers) => Promise<string | null>;
  admit: (
    projectId: string,
    userId: string,
    buildId: string,
    key: string,
  ) => Promise<{ deploymentId: string; replayed: boolean }>;
  cancel?: (userId: string, projectId: string, id: string) => Promise<void>;
  latest?: (
    userId: string,
    projectId: string,
    buildId: string,
  ) => Promise<unknown | null>;
  get: (
    userId: string,
    projectId: string,
    id: string,
  ) => Promise<unknown | null>;
}
export interface DeploymentHttpHandlers {
  list: (request: Request) => Promise<Response>;
  cancel: (
    request: Request,
    projectId: string,
    id: string,
  ) => Promise<Response>;
  latest: (request: Request, projectId: string) => Promise<Response>;
  create: (request: Request, projectId: string) => Promise<Response>;
  get: (request: Request, projectId: string, id: string) => Promise<Response>;
}

/** Adapts owned durable publishing to HTTP without exposing execution data. */
export function createDeploymentHttpHandlers(
  dependencies: DeploymentHttpDependencies,
): DeploymentHttpHandlers {
  const runAuthenticated = async (
    request: Request,
    run: (userId: string) => Promise<Response>,
  ): Promise<Response> => {
    try {
      const userId = await dependencies.userId(request.headers);
      if (!userId)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      return await run(userId);
    } catch (error) {
      if (error instanceof AccessDeniedError)
        return Response.json({ error: error.message }, { status: 401 });
      if (error instanceof DeploymentStoreError)
        return Response.json(
          { error: error.message },
          { status: error.status },
        );
      return Response.json(
        {
          error:
            "Publishing could not complete this request. Retry with the same request identity.",
        },
        { status: 503 },
      );
    }
  };
  // Deployment status and errors are session-bound, including denied requests.
  const handle = async (
    request: Request,
    run: (userId: string) => Promise<Response>,
  ): Promise<Response> => {
    const response = await runAuthenticated(request, run);
    response.headers.set("Cache-Control", "no-store");
    return response;
  };
  return {
    list: (request) =>
      handle(request, async (userId) => {
        const params = new URL(request.url).searchParams;
        if (params.getAll("offset").length > 1)
          return Response.json(
            { error: "Choose one history page." },
            { status: 400 },
          );
        const query = Object.fromEntries(params);
        const parsed = z
          .object({
            offset: z
              .string()
              .regex(/^(0|[1-9][0-9]{0,4})$/)
              .transform(Number)
              .pipe(z.number().max(10000))
              .optional(),
          })
          .strict()
          .safeParse(query);
        if (!parsed.success)
          return Response.json(
            { error: "Choose a valid history page." },
            { status: 400 },
          );
        if (!dependencies.list)
          return Response.json(
            { error: "Deployment history is unavailable." },
            { status: 503 },
          );
        return Response.json(
          await dependencies.list(userId, parsed.data.offset ?? 0),
          { headers: { "Cache-Control": "no-store" } },
        );
      }),
    cancel: (request, projectId, id) =>
      handle(request, async (userId) => {
        if (![projectId, id].every((value) => UUID.safeParse(value).success))
          return Response.json(
            { error: "Invalid deployment identity." },
            { status: 400 },
          );
        if (!dependencies.cancel)
          return Response.json(
            { error: "Cancellation is unavailable." },
            { status: 503 },
          );
        await dependencies.cancel(userId, projectId, id);
        return Response.json({ status: "cancelled" });
      }),
    latest: (request, projectId) =>
      handle(request, async (userId) => {
        const buildId = new URL(request.url).searchParams.get("buildId");
        if (
          ![projectId, buildId].every((value) => UUID.safeParse(value).success)
        )
          return Response.json(
            { error: "Select a valid project revision." },
            { status: 400 },
          );
        return Response.json({
          enabled: dependencies.enabled,
          deployment:
            (await dependencies.latest?.(userId, projectId, buildId!)) ?? null,
        });
      }),
    create: (request, projectId) =>
      handle(request, async (userId) => {
        if (!UUID.safeParse(projectId).success)
          return Response.json(
            { error: "Invalid project ID." },
            { status: 400 },
          );
        if (!dependencies.enabled)
          return Response.json(
            {
              error: "Publishing is not enabled for this instance.",
              code: "PUBLISHING_UNAVAILABLE",
            },
            { status: 503 },
          );
        const key = request.headers.get("Idempotency-Key");
        if (!UUID.safeParse(key).success)
          return Response.json(
            { error: "Provide an Idempotency-Key UUID." },
            { status: 400 },
          );
        const reader = request.body?.getReader();
        if (!reader)
          return Response.json(
            { error: "Select an explicit successful build." },
            { status: 400 },
          );
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          void reader.cancel().catch(() => {});
        }, BODY_TIMEOUT_MS);
        let bytes = 0;
        const chunks: Uint8Array[] = [];
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > MAX_BODY_BYTES)
              return Response.json(
                { error: "Publishing request is too large." },
                { status: 413 },
              );
            chunks.push(chunk.value);
          }
          if (timedOut)
            return Response.json(
              { error: "Publishing request timed out." },
              { status: 408 },
            );
        } finally {
          clearTimeout(timeout);
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        let parsed: z.infer<typeof RequestSchema>;
        try {
          parsed = RequestSchema.parse(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
          );
        } catch {
          return Response.json(
            { error: "Select an explicit successful build." },
            { status: 400 },
          );
        }
        const result = await dependencies.admit(
          projectId,
          userId,
          parsed.buildId,
          key!,
        );
        return Response.json(result, { status: 202 });
      }),
    get: (request, projectId, id) =>
      handle(request, async (userId) => {
        if (![projectId, id].every((value) => UUID.safeParse(value).success))
          return Response.json(
            { error: "Invalid deployment identity." },
            { status: 400 },
          );
        const result = await dependencies.get(userId, projectId, id);
        return result
          ? Response.json(result)
          : Response.json({ error: "Deployment not found." }, { status: 404 });
      }),
  };
}
