import { cleanupOwnedRuntimeArtifact } from "../artifacts/runtime-artifact-cleanup";
/**
 * COMPONENT: Interrupted Production operation clients
 * PURPOSE: Remove one operation's temporary SQL clients without touching its persistent database.
 * INPUTS: Exact project/resource/operation UUIDs and the caller's live cleanup fence.
 * OUTPUTS: Confirmed client/socket absence; no SQL result acknowledgement.
 * STEPS: Check every fixed helper name against exact Production or disposable labels, remove inspected immutable IDs, close its Production socket.
 * EDGE CASES: Disposable restore cleanup is separate; same-name foreign resources are refused.
 * ERROR STATES: Any unverified label, daemon response or lost fence preserves the blocker.
 */
import Docker from "dockerode";
import {
  databaseClientLabels,
  managedDatabaseLabels,
} from "./database-resource-policy";
import { cleanupScopedDatabaseSocket } from "./database-socket";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
/** Names select candidates only; every ownership label must match before deletion by immutable ID. */
export async function cleanupProductionOperationClients(input: {
  projectId: string;
  resourceId: string;
  operationId: string;
  assertHeld: () => Promise<void>;
}): Promise<void> {
  for (const id of [input.projectId, input.resourceId, input.operationId])
    if (!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
      throw new Error("Invalid operation cleanup scope.");
  if (input.resourceId === input.operationId)
    throw new Error("Persistent database cannot be a disposable operation.");
  const source = {
    projectId: input.projectId,
    resourceId: input.resourceId,
    environment: "production" as const,
  };
  const disposable = {
    ...source,
    resourceId: input.operationId,
    environment: "development" as const,
  };
  for (const kind of [
    "migration",
    "dump",
    "restore",
    "administrator",
  ] as const) {
    const name = `wrenly-database-${kind}-${input.operationId}`;
    await input.assertHeld();
    try {
      const found = await docker.getContainer(name).inspect();
      const candidates =
        kind === "administrator"
          ? [managedDatabaseLabels(disposable, "database-administrator")]
          : [
              databaseClientLabels(
                source,
                kind === "migration" ? "database-migration" : "database-backup",
              ),
              databaseClientLabels(
                disposable,
                kind === "migration" ? "database-migration" : "database-backup",
              ),
            ];
      if (
        found.Name !== `/${name}` ||
        !candidates.some((labels) =>
          Object.entries({
            ...labels,
            "io.wrenly.database-operation-id": input.operationId,
          }).every(([key, value]) => found.Config.Labels?.[key] === value),
        )
      )
        throw new Error("Interrupted operation helper ownership changed.");
      await input.assertHeld();
      await docker.getContainer(found.Id).remove({ force: true, v: true });
      await input.assertHeld();
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      ))
        throw error;
    }
  }
  await cleanupOwnedRuntimeArtifact(input.operationId, input.assertHeld);
  await input.assertHeld();
  await cleanupScopedDatabaseSocket(source, input.operationId);
  await input.assertHeld();
}
