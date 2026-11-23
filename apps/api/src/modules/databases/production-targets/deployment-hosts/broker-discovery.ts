/** Lost creation acknowledgements may discover an exact broker, never create or start one. */
import { z } from "zod";
import {
  ProductionRuntimeBrokerDiscovery,
  ProductionRuntimeBrokerInspectionReply,
} from "@wrenly/db/production-host-contract";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
/** A unique full-label match supplies an ID only; the independent inspector still proves image, isolation, volumes and network. */
export async function findRuntimeDatabaseBroker(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof ProductionRuntimeBrokerInspectionReply>> {
  const input = ProductionRuntimeBrokerDiscovery.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    const id = await runRuntimeHostDocker(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `label=io.wrenly.deployment-id=${input.deploymentId}`,
        "--filter",
        `label=io.wrenly.project-id=${input.projectId}`,
        "--filter",
        `label=io.wrenly.database-id=${input.resourceId}`,
        "--filter",
        "label=io.wrenly.database-environment=production",
        "--filter",
        "label=io.wrenly.role=production-database-broker",
        "--format",
        "{{.ID}}",
      ],
      signal,
    );
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new Error("Missing or ambiguous broker.");
    return await inspectRuntimeDatabaseBroker(
      { ...input, action: "inspect-runtime-broker", containerId: id },
      dockerId,
      signal,
      lock,
    );
  } catch {
    throw new Error(
      "The exact Production broker could not be discovered. No process was started and no credentials were sent.",
    );
  } finally {
    await lock.release();
  }
}
