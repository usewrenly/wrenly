/**
 * COMPONENT: Abandoned reader cleanup
 * PURPOSE: Remove only a reviewed read operation's helper and socket, never application data.
 * INPUTS: Verified resource scope, original read ID and caller's cleanup fence.
 * OUTPUTS: Confirmed helper/socket absence or a refusal retaining recovery.
 * STEPS: Inspect exact labels, recheck fence, remove owned helper, close owned socket.
 * EDGE CASES: Already-absent resources are safe; foreign same-name resources are not.
 * ERROR STATES: Wrong labels or failed removal never authorize clearing the recovery record.
 */
import Docker from "dockerode";
import {
  managedDatabaseLabels,
  type ManagedDatabaseScope,
} from "./database-resource-policy";
import { cleanupScopedDatabaseSocket } from "./database-socket";
import { DatabaseRuntimeError } from "./database-runtime";

const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Caller must save cleanup intent and hold the resource lock/lease before calling. */
export async function cleanupAbandonedDatabaseRead(
  scope: ManagedDatabaseScope,
  operationId: string,
  assertHeld: () => Promise<void>,
): Promise<void> {
  try {
    if (!UUID.test(operationId)) throw new Error("Invalid read identity");
    const labels = {
      ...managedDatabaseLabels(scope, "database-query"),
      "io.wrenly.database-operation-id": operationId,
    };
    const helper = docker.getContainer(`wrenly-database-query-${operationId}`);
    await assertHeld();
    try {
      const info = await helper.inspect();
      if (
        Object.entries(labels).some(
          ([key, value]) => info.Config.Labels?.[key] !== value,
        )
      )
        throw new Error("Foreign reader helper");
      await assertHeld();
      await helper.remove({ force: true, v: true });
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      ))
        throw error;
    }
    await assertHeld();
    await cleanupScopedDatabaseSocket(scope, operationId);
    await assertHeld();
  } catch {
    throw new DatabaseRuntimeError("abandoned reader cleanup");
  }
}
