/**
 * COMPONENT: Disposable application HTTP check
 * PURPOSE: Run a prepared image against one disposable runtime socket, then remove it.
 * INPUTS: Operation-bound image/socket, trusted bootstrap, runtime role and caller fences.
 * OUTPUTS: HTTP readiness only after confirmed helper cleanup; never whole-build success.
 * STEPS: Verify identities, save execution intent, deliver credentials on stdin, read
 * the bounded marker, independently record/confirm cleanup, then acknowledge execution.
 * EDGE CASES: Lost authority, cancellation and unknown Docker responses never retry.
 * ERROR STATES: Fixed safe failure; independent cleanup cannot acknowledge failed execution.
 */
import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARTIFACT_WORKSPACE_LABEL, ARTIFACT_WORKSPACE_VERSION } from "../../artifacts/artifact-policy";
import { managedDatabaseLabels, assertManagedDatabaseLabels, DATABASE_SOCKET_DIRECTORY, type ManagedDatabaseScope } from "../database-resource-policy";
import { DatabaseRuntimeError, type DatabaseRuntimeFence } from "../database-runtime";
import type { DatabaseSocketIdentity } from "../database-socket";
import { applicationDatabaseEnvironment } from "./environment";
import { DATABASE_APPLICATION_READY } from "./bootstrap";

const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const MAX_BUNDLE_BYTES = 128 * 1024;
const MAX_LIFETIME_MS = 60_000;
const APP_MEMORY_BYTES = 512 * 1024 ** 2;
const APP_CPU_NANO = 500_000_000;
const APP_PID_LIMIT = 64;

export interface ApplicationValidationCleanup {
  /** Independent lease/kernel check which must remain usable after user cancellation. */
  assertHeld: () => Promise<void>;
  beforeCleanup: (containerName: string) => Promise<void>;
  acknowledgeCleanup: (containerName: string) => Promise<void>;
}

async function removeApplicationCheck(
  name: string, labels: Record<string, string>, cleanup: ApplicationValidationCleanup,
): Promise<void> {
  await cleanup.assertHeld();
  await cleanup.beforeCleanup(name);
  await cleanup.assertHeld();
  try {
    const info = await docker.getContainer(name).inspect();
    if (Object.entries(labels).some(([key, value]) => info.Config.Labels?.[key] !== value))
      throw new Error("Foreign application check container");
    await cleanup.assertHeld();
    await docker.getContainer(info.Id).remove({ force: true, v: true });
  } catch (error) {
    if (!(typeof error === "object" && error && "statusCode" in error && error.statusCode === 404)) throw error;
  }
  await cleanup.acknowledgeCleanup(name);
}

/** Internal readiness check only. Caller prepares the image before creating the disposable database. */
export async function checkDisposableApplicationHttp(request: {
  scope: ManagedDatabaseScope;
  sourceResourceId: string;
  operationId: string;
  framework: "nextjs" | "laravel";
  imageId: string;
  socket: DatabaseSocketIdentity;
  role: { user: string; password: string };
  bootstrapBundle: Uint8Array;
  lifetimeMs: number;
  fence: DatabaseRuntimeFence;
  cleanup: ApplicationValidationCleanup;
  signal: AbortSignal;
}): Promise<{ httpReady: true }> {
  const input = { ...request, scope: { ...request.scope }, socket: { ...request.socket }, role: { ...request.role } };
  const name = `wrenly-database-application-${input.operationId}`;
  const effect = { kind: "create-container" as const, id: name };
  let directory: string | undefined;
  let child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  let attempted = false;
  let ready = false;
  let cleanupFailed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => { child?.kill("SIGKILL"); };
  const labels = { ...managedDatabaseLabels(input.scope, "database-application"),
    "io.wrenly.database-operation-id": input.operationId };
  const deadline = Date.now() + input.lifetimeMs;
  try {
    if (!UUID.test(input.operationId) || input.scope.resourceId !== input.operationId ||
        !UUID.test(input.sourceResourceId) || input.sourceResourceId === input.operationId ||
        !IMAGE.test(input.imageId) || !UUID.test(input.socket.id) ||
        input.socket.resourceId !== input.scope.resourceId || input.socket.projectId !== input.scope.projectId ||
        input.socket.volumeName !== `wrenly-database-socket-${input.socket.id}` ||
        !input.bootstrapBundle.byteLength || input.bootstrapBundle.byteLength > MAX_BUNDLE_BYTES ||
        !Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < 1 || input.lifetimeMs > MAX_LIFETIME_MS)
      throw new Error("Invalid disposable application check");
    applicationDatabaseEnvironment(input.framework, input.scope.resourceId, input.role);
    const role = { ...input.role };
    const bundle = input.bootstrapBundle.slice();
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const [image, socket, volume] = await Promise.all([
      docker.getImage(input.imageId).inspect(), docker.getContainer(input.socket.containerId).inspect(),
      docker.getVolume(input.socket.volumeName).inspect(),
    ]);
    if (image.Id !== input.imageId || image.Config.User !== "1000:1000" ||
        image.Config.Labels?.["io.wrenly.deployment-id"] !== input.operationId ||
        image.Config.Labels?.["io.wrenly.artifact-role"] !== "runtime" ||
        image.Config.Labels?.[ARTIFACT_WORKSPACE_LABEL] !== ARTIFACT_WORKSPACE_VERSION ||
        !socket.State.Running || socket.Image !== input.socket.imageId ||
        socket.Config.Labels?.["io.wrenly.database-socket-id"] !== input.socket.id ||
        volume.Labels?.["io.wrenly.database-socket-id"] !== input.socket.id ||
        volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length)
      throw new Error("Application image or socket changed");
    assertManagedDatabaseLabels(socket.Config, input.scope, "database-socket");
    assertManagedDatabaseLabels(volume, input.scope, "database-socket");
    try {
      await docker.getContainer(name).inspect();
      throw new Error("Existing application check requires reconciliation");
    } catch (error) {
      if (!(typeof error === "object" && error && "statusCode" in error && error.statusCode === 404)) throw error;
    }
    directory = await mkdtemp(join(tmpdir(), "wrenly-application-check-"));
    const bootstrap = join(directory, "bootstrap.js");
    await writeFile(bootstrap, bundle, { mode: 0o644, flag: "wx" });
    await input.fence.beforeEffect(effect);
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Application check deadline expired");
    attempted = true;
    const container = await docker.createContainer({ name, Image: image.Id, User: "0:0", WorkingDir: "/app",
      Entrypoint: ["bun"], Cmd: ["--no-env-file", "/wrenly/bootstrap.js"], Labels: labels,
      OpenStdin: true, StdinOnce: true, AttachStdin: true,
      HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], CapAdd: ["SETUID", "SETGID"],
        SecurityOpt: ["no-new-privileges:true"], Memory: APP_MEMORY_BYTES, MemorySwap: APP_MEMORY_BYTES,
        NanoCpus: APP_CPU_NANO, PidsLimit: APP_PID_LIMIT, LogConfig: { Type: "none", Config: {} },
        Mounts: [{ Type: "bind", Source: bootstrap, Target: "/wrenly/bootstrap.js", ReadOnly: true },
          { Type: "volume", Source: volume.Name, Target: DATABASE_SOCKET_DIRECTORY, ReadOnly: true }],
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
          ...(input.framework === "laravel" ? { "/app/bootstrap/cache": "rw,nosuid,nodev,size=8m,uid=1000,gid=1000",
            "/app/storage": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000" } : {}) },
      },
    });
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    await container.start();
    child = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", "attach", "--sig-proxy=false", container.id], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    input.signal.addEventListener("abort", stop, { once: true });
    if (input.signal.aborted) stop();
    timer = setTimeout(stop, Math.max(1, deadline - Date.now()));
    child.stdin.write(JSON.stringify({ framework: input.framework, resourceId: input.scope.resourceId, role,
      lifetimeMs: Math.max(1, deadline - Date.now()) }));
    child.stdin.end();
    const reader = child.stdout.getReader();
    let output = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        output += Buffer.from(part.value).toString("utf8");
        if (output.length > DATABASE_APPLICATION_READY.length + 1) throw new Error("Unexpected application check output");
        if (output === `${DATABASE_APPLICATION_READY}\n`) { ready = true; break; }
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    if (!ready || Date.now() >= deadline) throw new Error("Application HTTP readiness not confirmed");
  } catch {
    ready = false;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    stop();
    if (child) {
      try { await child.exited; } catch { cleanupFailed = true; }
    }
    try {
      if (attempted) await removeApplicationCheck(name, labels, input.cleanup);
    } catch { cleanupFailed = true; }
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    catch { cleanupFailed = true; }
  }
  if (cleanupFailed) throw new DatabaseRuntimeError("application check cleanup");
  if (!ready) throw new DatabaseRuntimeError("application HTTP check");
  await input.fence.assertHeld();
  input.signal.throwIfAborted();
  await input.fence.acknowledgeEffect(effect);
  return { httpReady: true };
}
