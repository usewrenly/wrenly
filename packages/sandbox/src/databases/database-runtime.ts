// Creates and inspects separately owned application database containers, networks and storage.
// Every mutation requires the caller to persist intent and hold its execution fence;
// uncertain results preserve data and require reconciliation rather than implicit retries.
import Docker from "dockerode";
import type { AppDatabaseRuntimeIdentity } from "@wrenly/db/app-database-runtime-contract";
import {
  managedDatabaseLabels,
  assertManagedDatabaseLabels,
  managedDatabaseNames,
  verifyManagedDatabaseResources,
  type ManagedDatabaseScope,
  type ManagedDatabaseInspection,
} from "./database-resource-policy";

export const POSTGRES_RUNTIME_IMAGE = "wrenly/postgres-runtime:17";
const DOCKER_TIMEOUT_MS = 10_000;
const INITIALIZATION_TIMEOUT_MS = 60_000;
const POLL_MS = 150;
const LOG_TAIL_LINES = 80;
const POSTGRES_UID = "70:70";
const DATA_DIRECTORY = "/var/lib/postgresql/data";
const INITIALIZED_MARKER =
  "PostgreSQL init process complete; ready for start up.";
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: DOCKER_TIMEOUT_MS,
});
const LIMITS: Docker.HostConfig = {
  Memory: 512 * 1024 ** 2,
  NanoCpus: 1_000_000_000,
  PidsLimit: 64,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges:true"],
  ReadonlyRootfs: true,
  Tmpfs: {
    "/tmp": "rw,nosuid,nodev,size=64m",
    "/var/run/postgresql": "rw,nosuid,nodev,size=1m",
  },
  LogConfig: {
    Type: "json-file",
    Config: { "max-size": "1m", "max-file": "1" },
  },
};
export type ManagedDatabaseIdentity = AppDatabaseRuntimeIdentity;
export interface DatabaseRuntimeEffect {
  kind:
    | "create-network"
    | "create-volume"
    | "initialize"
    | "create-container"
    | "start"
    | "stop"
    | "create-socket"
    | "provision-roles"
    | "read-database"
    | "apply-migrations"
    | "enforce-policy"
    | "terminate-sessions"
    | "inspect-schema"
    | "capture-backup"
    | "restore-backup";
  id: string;
}
export interface DatabaseRuntimeFence {
  /** Must verify both the durable lease and operation kernel lock, including during readiness polling. */
  assertHeld: () => Promise<void>;
  beforeEffect: (effect: DatabaseRuntimeEffect) => Promise<void>;
  acknowledgeEffect: (
    effect: DatabaseRuntimeEffect,
    identity?: ManagedDatabaseIdentity,
  ) => Promise<void>;
}
export class DatabaseRuntimeError extends Error {
  constructor(
    public readonly phase: string,
    cause?: unknown,
  ) {
    super(
      `Database ${phase} could not be confirmed. Preserve its data and reconcile the saved operation.`,
      { cause },
    );
    this.name = "DatabaseRuntimeError";
  }
}
function absent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}
async function requireAbsent(inspect: () => Promise<unknown>): Promise<void> {
  try {
    await inspect();
  } catch (error) {
    if (absent(error)) return;
    throw error;
  }
  throw new DatabaseRuntimeError(
    "resource creation: an existing resource cannot be adopted",
  );
}
async function effect<T>(
  fence: DatabaseRuntimeFence,
  entry: DatabaseRuntimeEffect,
  execute: () => Promise<T>,
  identity?: (result: T) => ManagedDatabaseIdentity,
): Promise<T> {
  await fence.assertHeld();
  await fence.beforeEffect(entry);
  await fence.assertHeld();
  const result = await execute();
  await fence.assertHeld();
  await fence.acknowledgeEffect(entry, identity?.(result));
  return result;
}
async function ready(
  container: Docker.Container,
  fence: DatabaseRuntimeFence,
  signal: AbortSignal,
  initialize: boolean,
): Promise<void> {
  const deadline = Date.now() + INITIALIZATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    await fence.assertHeld();
    const info = await container.inspect();
    if (!info.State.Running) throw new DatabaseRuntimeError("startup");
    let initialized = !initialize;
    if (initialize) {
      const logs = await container.logs({
        stdout: true,
        stderr: true,
        tail: LOG_TAIL_LINES,
      });
      initialized = logs.toString().includes(INITIALIZED_MARKER);
    }
    if (initialized && info.State.Health?.Status === "healthy") return;
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new DatabaseRuntimeError("readiness deadline");
}
function health(
  administrator: string,
  initializing = false,
): Docker.HealthConfig {
  return {
    Test: [
      "CMD",
      "pg_isready",
      "-h",
      initializing ? "/var/run/postgresql" : "/tmp",
      "-U",
      administrator,
      "-d",
      "app",
    ],
    Interval: 1_000_000_000,
    Timeout: 1_000_000_000,
    Retries: 3,
    StartPeriod: 1_000_000_000,
  };
}

/** Creates new resources only; any uncertain effect retains its intent and all persistent data. */
export async function createManagedDatabase(input: {
  scope: ManagedDatabaseScope;
  operationId: string;
  administrator: { user: string; password: string };
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}): Promise<ManagedDatabaseIdentity> {
  let phase = "preflight";
  let inputProcess: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
  try {
    const { scope, administrator, fence, signal } = input;
    const names = managedDatabaseNames(scope);
    if (
      !UUID.test(input.operationId) ||
      administrator.user !==
        `wrenly_${scope.resourceId.replaceAll("-", "")}_admin` ||
      !/^[a-f0-9]{64}$/.test(administrator.password)
    )
      throw new DatabaseRuntimeError("input validation");
    signal.throwIfAborted();
    await fence.assertHeld();
    const image = await docker.getImage(POSTGRES_RUNTIME_IMAGE).inspect();
    if (!IMAGE_ID.test(image.Id) || image.Config.User !== POSTGRES_UID)
      throw new DatabaseRuntimeError("trusted PostgreSQL image validation");
    const initializerName = `${names.container}-initialize-${input.operationId}`;
    await requireAbsent(() => docker.getContainer(names.container).inspect());
    await requireAbsent(() => docker.getContainer(initializerName).inspect());
    await requireAbsent(() => docker.getVolume(names.volume).inspect());
    await requireAbsent(() => docker.getNetwork(names.network).inspect());
    phase = "private network creation";
    const network = await effect(
      fence,
      { kind: "create-network", id: names.network },
      () =>
        docker.createNetwork({
          Name: names.network,
          Driver: "bridge",
          Internal: true,
          EnableIPv6: false,
          Labels: managedDatabaseLabels(scope, "database-network"),
        }),
    );
    phase = "persistent volume creation";
    await effect(
      fence,
      { kind: "create-volume", id: names.volume },
      async () => {
        await docker.createVolume({
          Name: names.volume,
          Driver: "local",
          Labels: managedDatabaseLabels(scope, "database-data"),
        });
        const volume = await docker.getVolume(names.volume).inspect();
        if (
          volume.Name !== names.volume ||
          volume.Driver !== "local" ||
          Object.entries(managedDatabaseLabels(scope, "database-data")).some(
            ([key, value]) => volume.Labels?.[key] !== value,
          )
        )
          throw new DatabaseRuntimeError("volume ownership");
      },
    );
    phase = "initialization";
    await effect(
      fence,
      { kind: "initialize", id: initializerName },
      async () => {
        const initializer = await docker.createContainer({
          name: initializerName,
          Image: image.Id,
          User: "0:0",
          Entrypoint: ["sh", "-ec"],
          Cmd: [
            'IFS= read -r POSTGRES_PASSWORD; test "${#POSTGRES_PASSWORD}" -eq 64; export POSTGRES_PASSWORD; exec /usr/local/bin/docker-entrypoint.sh postgres -c unix_socket_directories=/var/run/postgresql',
          ],
          Env: [
            `POSTGRES_USER=${administrator.user}`,
            "POSTGRES_DB=app",
            "POSTGRES_INITDB_ARGS=--auth-local=scram-sha-256 --auth-host=scram-sha-256",
            "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
          ],
          Labels: managedDatabaseLabels(scope, "database-initializer"),
          OpenStdin: true,
          StdinOnce: true,
          AttachStdin: true,
          Healthcheck: health(administrator.user, true),
          HostConfig: {
            ...LIMITS,
            NetworkMode: "none",
            CapAdd: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID"],
            Mounts: [
              { Type: "volume", Source: names.volume, Target: DATA_DIRECTORY },
            ],
          },
        });
        await fence.assertHeld();
        signal.throwIfAborted();
        await initializer.start();
        inputProcess = Bun.spawn(
          [
            "docker",
            "--host",
            "unix:///var/run/docker.sock",
            "attach",
            "--sig-proxy=false",
            initializer.id,
          ],
          {
            stdin: "pipe",
            stdout: "ignore",
            stderr: "ignore",
            env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
          },
        );
        inputProcess.stdin.write(administrator.password + "\n");
        inputProcess.stdin.end();
        await ready(initializer, fence, signal, true);
        await fence.assertHeld();
        await initializer.stop({ t: 10 });
        await initializer.remove({ v: true });
        if ((await inputProcess.exited) !== 0)
          throw new DatabaseRuntimeError("initializer input delivery");
        inputProcess = undefined;
      },
    );
    phase = "database container creation";
    const container = await effect(
      fence,
      { kind: "create-container", id: names.container },
      () =>
        docker.createContainer({
          name: names.container,
          Image: image.Id,
          User: POSTGRES_UID,
          Entrypoint: ["postgres"],
          Cmd: [
            "-D",
            DATA_DIRECTORY,
            "-c",
            "listen_addresses=*",
            "-c",
            "unix_socket_directories=/tmp",
            "-c",
            "max_connections=24",
            "-c",
            "shared_buffers=64MB",
            "-c",
            "log_error_verbosity=terse",
            "-c",
            "log_min_error_statement=panic",
          ],
          Labels: managedDatabaseLabels(scope, "database"),
          Healthcheck: health(administrator.user),
          HostConfig: {
            ...LIMITS,
            NetworkMode: network.id,
            Mounts: [
              { Type: "volume", Source: names.volume, Target: DATA_DIRECTORY },
            ],
          },
        }),
      (result) => ({
        version: 1,
        containerId: result.id,
        networkId: network.id,
        volumeName: names.volume,
        imageId: image.Id,
      }),
    );
    const identity: ManagedDatabaseIdentity = {
      version: 1,
      containerId: container.id,
      networkId: network.id,
      volumeName: names.volume,
      imageId: image.Id,
    };
    phase = "database start";
    await effect(fence, { kind: "start", id: container.id }, async () => {
      signal.throwIfAborted();
      await container.start();
      await ready(container, fence, signal, false);
    });
    await inspectManagedDatabase(scope, identity);
    return identity;
  } catch (error) {
    throw new DatabaseRuntimeError(phase, error);
  } finally {
    if (inputProcess?.exitCode === null) {
      inputProcess.kill("SIGKILL");
      await inputProcess.exited;
    }
  }
}

/** Inspects saved handles only; a missing container/volume never triggers replacement initialization. */
export async function inspectManagedDatabase(
  scope: ManagedDatabaseScope,
  identity: ManagedDatabaseIdentity,
): Promise<{ address: string; port: number }> {
  try {
    managedDatabaseNames(scope);
    const [volume, network, container] = await Promise.all([
      docker.getVolume(identity.volumeName).inspect(),
      docker.getNetwork(identity.networkId).inspect(),
      docker.getContainer(identity.containerId).inspect(),
    ]);
    return verifyManagedDatabaseResources(
      scope,
      identity,
      { volume, network, container } as ManagedDatabaseInspection,
      { allowStopped: true },
    );
  } catch {
    throw new DatabaseRuntimeError("saved resource inspection");
  }
}

/** Stop/start preserves the exact data volume and refuses missing or changed saved resources. */
export async function setManagedDatabaseRunning(
  scope: ManagedDatabaseScope,
  identity: ManagedDatabaseIdentity,
  running: boolean,
  fence: DatabaseRuntimeFence,
  signal: AbortSignal,
): Promise<void> {
  try {
    await inspectManagedDatabase(scope, identity);
    const container = docker.getContainer(identity.containerId);
    const state = await container.inspect();
    if (state.State.Running === running)
      throw new DatabaseRuntimeError("state changed before action");
    await effect(
      fence,
      { kind: running ? "start" : "stop", id: identity.containerId },
      async () => {
        signal.throwIfAborted();
        if (running) {
          await container.start();
          await ready(container, fence, signal, false);
        } else await container.stop({ t: 10 });
      },
    );
  } catch {
    throw new DatabaseRuntimeError(running ? "restart" : "stop");
  }
}

/** Read-only recovery proof for the exact saved resources; never starts or repairs them. */
export async function inspectManagedDatabaseState(
  scope: ManagedDatabaseScope,
  identity: ManagedDatabaseIdentity,
): Promise<"ready" | "stopped"> {
  try {
    await inspectManagedDatabase(scope, identity);
    const info = await docker.getContainer(identity.containerId).inspect();
    if (info.State.Paused || info.State.Restarting || info.State.Dead)
      throw new DatabaseRuntimeError("unstable recovery state");
    if (!info.State.Running) return "stopped";
    if (info.State.Health?.Status !== "healthy")
      throw new DatabaseRuntimeError("unhealthy recovery state");
    return "ready";
  } catch {
    throw new DatabaseRuntimeError("saved runtime recovery inspection");
  }
}

/** Removes only operation-derived disposable verification resources, never the source database. */
export async function cleanupDisposableDatabase(
  scope: ManagedDatabaseScope,
  operationId: string,
  sourceResourceId: string,
): Promise<void> {
  if (
    scope.resourceId !== operationId ||
    scope.resourceId === sourceResourceId ||
    !UUID.test(sourceResourceId)
  )
    throw new DatabaseRuntimeError("invalid disposable cleanup scope");
  const names = managedDatabaseNames(scope);
  const containers: Docker.Container[] = [];
  for (const [name, kind] of [
    [names.container, "database"],
    [`${names.container}-initialize-${operationId}`, "database-initializer"],
  ] as const) {
    try {
      const container = docker.getContainer(name),
        info = await container.inspect();
      assertManagedDatabaseLabels(info.Config, scope, kind);
      if (info.Name !== `/${name}`)
        throw new DatabaseRuntimeError("foreign disposable container");
      // Remove the inspected immutable ID, not a name that could be reassigned.
      containers.push(docker.getContainer(info.Id));
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  let volume: Docker.Volume | undefined, network: Docker.Network | undefined;
  try {
    const handle = docker.getVolume(names.volume),
      info = await handle.inspect();
    assertManagedDatabaseLabels(info, scope, "database-data");
    if (info.Name !== names.volume)
      throw new DatabaseRuntimeError("foreign disposable volume");
    volume = handle;
  } catch (error) {
    if (!absent(error)) throw error;
  }
  try {
    const handle = docker.getNetwork(names.network),
      info = await handle.inspect();
    assertManagedDatabaseLabels(info, scope, "database-network");
    if (info.Name !== names.network)
      throw new DatabaseRuntimeError("foreign disposable network");
    for (const id of Object.keys(info.Containers ?? {})) {
      const attached = await docker.getContainer(id).inspect();
      assertManagedDatabaseLabels(attached.Config, scope,
        attached.Name === `/${names.container}` ? "database" : "database-initializer");
      // Socket/helper connections must be closed first. Matching project labels
      // alone do not authorize deleting a database underneath another container.
      if (!containers.some((container) => container.id === attached.Id))
        throw new DatabaseRuntimeError("foreign disposable network attachment");
    }
    network = docker.getNetwork(info.Id);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  for (const container of containers)
    await container.remove({ force: true, v: true });
  if (network) await network.remove();
  if (volume) await volume.remove();
}
