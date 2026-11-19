/** Restart one preserved broker after independently journaled maintenance intent; never create or adopt containers. */
import { z } from "zod";
import {
  ProductionRuntimeBrokerRestart,
  ProductionRuntimeBrokerInspectionReply,
} from "@wrenly/db/production-host-contract";
import { productionDatabaseRuntimeSocketConfiguration } from "@wrenly/sandbox/production-database-socket-policy";
import { acquireRuntimeHostLock } from "./host-lock";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
import { runRuntimeHostDocker } from "./docker-command";
import {
  resolveRuntimeHostAddresses,
  type RuntimeHostLookup,
} from "./transport";
const READY_TIMEOUT_MS = 15000,
  POLL_MS = 100,
  MAX_CONFIGURATION_BYTES = 48 * 1024;
/** Requires a fresh persisted maintenance effect. Lost replies are inspected, never retried as another handoff. */
export async function restartRuntimeDatabaseBroker(
  raw: unknown,
  dockerId: string,
  parent: AbortSignal,
  resolver?: RuntimeHostLookup,
): Promise<z.infer<typeof ProductionRuntimeBrokerInspectionReply>> {
  const input = ProductionRuntimeBrokerRestart.parse(raw),
    signal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const payload = JSON.stringify(
    productionDatabaseRuntimeSocketConfiguration({
      resourceId: input.resourceId,
      runtimeRole: input.runtimeRole,
      upstream: input.upstream,
      certificateAuthority: input.certificateAuthority,
    }),
  );
  if (Buffer.byteLength(payload) > MAX_CONFIGURATION_BYTES)
    throw new Error("Broker settings exceed their limit.");
  const inspection = {
    ...input,
    action: "inspect-runtime-broker",
    runtimeRole: undefined,
    addresses: undefined,
    certificateAuthority: undefined,
  };
  // Strict inspection contracts omit credentials rather than accepting them accidentally.
  const {
    runtimeRole: _role,
    addresses: _addresses,
    certificateAuthority: _ca,
    ...proof
  } = inspection;
  void _role;
  void _addresses;
  void _ca;
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const stop = (): void => {
    if (child?.exitCode === null) child.kill("SIGKILL");
  };
  async function target(): Promise<void> {
    const addresses = await resolveRuntimeHostAddresses(
      input.upstream.hostname,
      signal,
      resolver,
    );
    if (
      JSON.stringify(addresses) !== JSON.stringify(input.addresses) ||
      !addresses.includes(input.upstream.address)
    )
      throw new Error("Production addresses changed.");
  }
  try {
    lock.assertHeld();
    signal.throwIfAborted();
    await target();
    const before = await inspectRuntimeDatabaseBroker(
      proof,
      dockerId,
      signal,
      lock,
    );
    // A running process may already have consumed stdin even when health is not ready.
    // Never attach credentials to it again merely because a healthcheck failed.
    if (before.running)
      throw new Error(
        "Inspect the running broker; its settings must not be resent.",
      );
    lock.assertHeld();
    signal.throwIfAborted();
    await runRuntimeHostDocker(["start", input.containerId], signal);
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "attach",
        "--sig-proxy=false",
        input.containerId,
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent" },
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    signal.addEventListener("abort", stop, { once: true });
    signal.throwIfAborted();
    if (!child.stdin || typeof child.stdin === "number")
      throw new Error("Broker channel unavailable.");
    child.stdin.write(payload);
    child.stdin.end();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (true) {
      lock.assertHeld();
      signal.throwIfAborted();
      const current = await inspectRuntimeDatabaseBroker(
        proof,
        dockerId,
        signal,
        lock,
      );
      if (!current.running || Date.now() > deadline)
        throw new Error("Broker readiness unconfirmed.");
      if (current.socketReady) {
        await target();
        return current;
      }
      await Bun.sleep(POLL_MS);
    }
  } catch {
    throw new Error(
      "Preserved broker restart could not be confirmed. Inspect its saved maintenance effect; no replacement was created.",
    );
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
    await lock.release();
  }
}
