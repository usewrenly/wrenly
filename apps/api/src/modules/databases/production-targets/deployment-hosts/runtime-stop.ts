/** Fixed owner Stop preserves exact containers/storage and verifies stopped state under the host lock. */
import {
  ProductionRuntimeApplicationStop,
  ProductionRuntimeBrokerStop,
} from "@wrenly/db/production-host-contract";
import { acquireRuntimeHostLock } from "./host-lock";
import { executeRuntimeApplicationInspection } from "./application-inspection";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
import { runRuntimeHostDocker } from "./docker-command";
const STOP_GRACE_SECONDS = "5";
/** No name lookup or replacement adoption is allowed; the inspection proves policy before stopping the immutable ID. */
export async function stopRuntimeApplication(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): ReturnType<typeof executeRuntimeApplicationInspection> {
  const input = ProductionRuntimeApplicationStop.parse(raw);
  const inspection = { ...input, action: "inspect-runtime-application" };
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  try {
    const before = await executeRuntimeApplicationInspection(
      inspection,
      dockerId,
      signal,
      lock,
    );
    lock.assertHeld();
    signal.throwIfAborted();
    if (before.running)
      await runRuntimeHostDocker(
        ["stop", "--time", STOP_GRACE_SECONDS, before.containerId],
        signal,
      );
    const after = await executeRuntimeApplicationInspection(
      inspection,
      dockerId,
      signal,
      lock,
    );
    if (after.running) throw new Error("Application Stop was not confirmed.");
    return after;
  } finally {
    await lock.release();
  }
}
/** A broker Stop never drops its credential-free socket volume or changes the upstream database. */
export async function stopRuntimeDatabaseBroker(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): ReturnType<typeof inspectRuntimeDatabaseBroker> {
  const input = ProductionRuntimeBrokerStop.parse(raw);
  const inspection = { ...input, action: "inspect-runtime-broker" };
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  try {
    const before = await inspectRuntimeDatabaseBroker(
      inspection,
      dockerId,
      signal,
      lock,
    );
    lock.assertHeld();
    signal.throwIfAborted();
    if (before.running)
      await runRuntimeHostDocker(
        ["stop", "--time", STOP_GRACE_SECONDS, before.containerId],
        signal,
      );
    const after = await inspectRuntimeDatabaseBroker(
      inspection,
      dockerId,
      signal,
      lock,
    );
    if (after.running) throw new Error("Broker Stop was not confirmed.");
    return after;
  } finally {
    await lock.release();
  }
}
