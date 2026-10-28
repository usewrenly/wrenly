/**
 * Authenticated model-picker HTTP endpoint.
 * Resolves configured service metadata and read-only model lists server-side; never returns API tokens.
 * Responses are private/no-store and provider failures have safe diagnostics.
 */
import { logger } from "../../../lib/logger";

import { requireUserId } from "../../auth/access/session";
import { discoverConfiguredModels } from "./configured-discovery";
import { db } from "@wrenly/db";
import { resolve } from "node:path";

export async function getModels(request: Request): Promise<Response> {
  try {
    await requireUserId(request.headers);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = await discoverConfiguredModels(
      db,
      resolve(process.env.WRENLY_DATA_DIR ?? ".local/wrenly"),
    );
    return Response.json(data, {
      headers: { "Cache-Control": "no-store, private" },
    });
  } catch (error) {
    logger.error("[api] model discovery failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return Response.json({ error: "Model discovery failed" }, { status: 500 });
  }
}
