/**
 * COMPONENT: Disposable validation cleanup
 * PURPOSE: Remove an operation's generated helpers/socket/database without touching real app data.
 * INPUTS: Exact disposable scope, original operation and real source-resource identity, cleanup fence.
 * OUTPUTS: Independently acknowledged helper/socket/database absence.
 * STEPS: Save each category's intent, inspect exact labels, remove immutable helper IDs,
 * close the scoped socket, then remove only the operation-owned disposable database.
 * EDGE CASES: Missing resources are safe; same-name foreign resources preserve the blocker.
 * ERROR STATES: Cleanup never acknowledges the old SQL/app effect or runs generated code.
 */
import Docker from "dockerode";
import {
  managedDatabaseLabels,
  type ManagedDatabaseScope,
} from "./database-resource-policy";
import { cleanupScopedDatabaseSocket } from "./database-socket";
import {
  cleanupDisposableDatabase,
  DatabaseRuntimeError,
} from "./database-runtime";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
export interface ValidationResourceCleanup {
  assertHeld: () => Promise<void>;
  beforeCleanup: (
    kind: "application" | "socket" | "database",
    id: string,
  ) => Promise<void>;
  acknowledgeCleanup: (
    kind: "application" | "socket" | "database",
    id: string,
  ) => Promise<void>;
}

/** Caller holds the source resource lock and independent durable cleanup claim. */
export async function cleanupDatabaseValidationResources(
  scope: ManagedDatabaseScope,
  operationId: string,
  sourceResourceId: string,
  cleanup: ValidationResourceCleanup,
): Promise<void> {
  try {
    if (scope.resourceId !== operationId || operationId === sourceResourceId)
      throw new Error("Not a disposable scope");
    managedDatabaseLabels(
      { ...scope, resourceId: sourceResourceId },
      "database",
    );
    const appId = `wrenly-database-application-${operationId}`;
    await cleanup.assertHeld();
    await cleanup.beforeCleanup("application", appId);
    for (const kind of ["application", "administrator", "migration"] as const) {
      await cleanup.assertHeld();
      const name = `wrenly-database-${kind}-${operationId}`;
      try {
        const info = await docker.getContainer(name).inspect();
        const labels = {
          ...managedDatabaseLabels(scope, `database-${kind}`),
          "io.wrenly.database-operation-id": operationId,
        };
        if (
          info.Name !== `/${name}` ||
          Object.entries(labels).some(
            ([key, value]) => info.Config.Labels?.[key] !== value,
          )
        )
          throw new Error("Foreign validation helper");
        await cleanup.assertHeld();
        await docker.getContainer(info.Id).remove({ force: true, v: true });
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
    await cleanup.assertHeld();
    await cleanup.acknowledgeCleanup("application", appId);
    const socketId = `wrenly-database-socket-${operationId}`;
    await cleanup.assertHeld();
    await cleanup.beforeCleanup("socket", socketId);
    await cleanup.assertHeld();
    await cleanupScopedDatabaseSocket(scope, operationId);
    await cleanup.assertHeld();
    await cleanup.acknowledgeCleanup("socket", socketId);
    const databaseId = `wrenly-database-${operationId}`;
    await cleanup.assertHeld();
    await cleanup.beforeCleanup("database", databaseId);
    await cleanup.assertHeld();
    await cleanupDisposableDatabase(scope, operationId, sourceResourceId);
    await cleanup.assertHeld();
    await cleanup.acknowledgeCleanup("database", databaseId);
  } catch {
    throw new DatabaseRuntimeError("disposable validation cleanup");
  }
}
