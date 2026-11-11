/** Exact deployment-owned empty socket volumes; unknown creation is inspected, never automatically adopted or repeated. */
import { z } from "zod";
import {
  ProductionRuntimeVolumeRequest,
  ProductionRuntimeVolumeReply,
} from "@wrenly/db/production-host-contract";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
const Volume = z.object({
  Name: z.string(),
  Driver: z.literal("local"),
  Scope: z.literal("local"),
  CreatedAt: z.string().min(1).max(64),
  Labels: z.record(z.string(), z.string()),
  Options: z.record(z.string(), z.string()).nullable().optional(),
});
function names(input: ProductionRuntimeVolumeRequest): {
  http: string;
  database: string;
} {
  return {
    http: `wrenly-deployment-http-${input.deploymentId}`,
    database: `wrenly-deployment-db-${input.deploymentId}`,
  };
}
function labels(
  input: ProductionRuntimeVolumeRequest,
  kind: "http" | "database",
): Record<string, string> {
  return {
    "io.wrenly.deployment-id": input.deploymentId,
    "io.wrenly.project-id": input.projectId,
    "io.wrenly.database-id": input.resourceId,
    "io.wrenly.database-environment": "production",
    "io.wrenly.role": `production-${kind}-volume`,
  };
}
/** The caller authenticates the host and daemon before entering; this function checks the exact saved identity again. */
export async function executeRuntimeVolumeRequest(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof ProductionRuntimeVolumeReply>> {
  const input = ProductionRuntimeVolumeRequest.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  const volumeNames = names(input);
  async function inspect(
    kind: "http" | "database",
  ): Promise<{ name: string; createdAt: string } | null> {
    lock.assertHeld();
    signal.throwIfAborted();
    const name = volumeNames[kind];
    const listed = await runRuntimeHostDocker(
      ["volume", "ls", "--filter", `name=^${name}$`, "--format", "{{.Name}}"],
      signal,
    );
    if (!listed) return null;
    if (listed !== name) throw new Error("Ambiguous deployment volume.");
    const value = z
      .array(Volume)
      .length(1)
      .parse(
        JSON.parse(
          await runRuntimeHostDocker(["volume", "inspect", name], signal),
        ),
      )[0]!;
    if (
      value.Name !== name ||
      Object.keys(value.Options ?? {}).length !== 0 ||
      Object.entries(labels(input, kind)).some(
        ([key, expected]) => value.Labels[key] !== expected,
      )
    )
      throw new Error("Deployment volume ownership changed.");
    return { name, createdAt: value.CreatedAt };
  }
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    if (input.action !== "inspect-runtime-volumes") {
      const kind = input.action === "create-http-volume" ? "http" : "database";
      if (await inspect(kind))
        throw new Error(
          "Existing deployment volume requires explicit inspection.",
        );
      lock.assertHeld();
      signal.throwIfAborted();
      const created = await runRuntimeHostDocker(
        [
          "volume",
          "create",
          "--driver",
          "local",
          ...Object.entries(labels(input, kind)).flatMap(([key, value]) => [
            "--label",
            `${key}=${value}`,
          ]),
          volumeNames[kind],
        ],
        signal,
      );
      if (created !== volumeNames[kind] || !(await inspect(kind)))
        throw new Error("Deployment volume creation was not verified.");
    }
    const http = await inspect("http"),
      database = await inspect("database");
    lock.assertHeld();
    signal.throwIfAborted();
    return ProductionRuntimeVolumeReply.parse({
      version: 1,
      nonce: input.nonce,
      dockerId,
      http,
      database,
    });
  } catch {
    throw new Error(
      "Deployment volume operation could not be confirmed. Inspect the saved operation before continuing.",
    );
  } finally {
    await lock.release();
  }
}
