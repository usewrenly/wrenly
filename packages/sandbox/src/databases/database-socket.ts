// Gives one authenticated database role a Unix-only connection to a verified database.
// Credentials arrive through stdin, not Docker environment/command metadata or host files.
import Docker from "dockerode";
import type { AppDatabaseSocketIdentity } from "@wrenly/db/app-database-runtime-contract";
import {
  inspectManagedDatabase,
  DatabaseRuntimeError,
  type ManagedDatabaseIdentity,
  type DatabaseRuntimeFence,
} from "./database-runtime";
import {
  managedDatabaseLabels,
  localDatabaseSocketConfiguration,
  DATABASE_SOCKET_DIRECTORY,
  DATABASE_SOCKET_PATH,
  type ManagedDatabaseScope,
} from "./database-resource-policy";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
export const DATABASE_SOCKET_IMAGE = "wrenly/database-socket:1";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TIMEOUT_MS = 15_000;
const POLL_MS = 100;
export type DatabaseSocketIdentity = AppDatabaseSocketIdentity;

/** Opens a scoped socket. Caller must retain its lease/kernel lock until cleanup; no automatic adoption or retries. */
export async function startDatabaseSocket(input: {
  scope: ManagedDatabaseScope;
  database: ManagedDatabaseIdentity;
  socketId: string;
  role: {
    kind: "runtime" | "migrator" | "reader";
    user: string;
    password: string;
  };
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}): Promise<DatabaseSocketIdentity> {
  let child: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
  try {
    if (!UUID.test(input.socketId)) throw new Error("Invalid socket identity");
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const upstream = await inspectManagedDatabase(input.scope, input.database);
    const configuration = localDatabaseSocketConfiguration(
      input.scope,
      upstream,
      input.role,
    );
    const image = await docker.getImage(DATABASE_SOCKET_IMAGE).inspect();
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
      image.Config.User !== "1000:1000"
    )
      throw new Error("Unverified socket toolchain");
    const name = `wrenly-database-socket-${input.socketId}`;
    const labels = {
      ...managedDatabaseLabels(input.scope, "database-socket"),
      "io.wrenly.database-socket-id": input.socketId,
    };
    for (const resource of [
      docker.getVolume(name),
      docker.getContainer(name),
    ]) {
      try {
        await resource.inspect();
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          error.statusCode === 404
        )
          continue;
        throw error;
      }
      throw new Error("Existing socket resources require reconciliation");
    }
    await input.fence.beforeEffect({ kind: "create-socket", id: name });
    await input.fence.assertHeld();
    await docker.createVolume({ Name: name, Driver: "local", Labels: labels });
    const volume = await docker.getVolume(name).inspect();
    if (
      volume.Name !== name ||
      Object.keys(volume.Options ?? {}).length ||
      Object.entries(labels).some(
        ([key, value]) => volume.Labels?.[key] !== value,
      )
    )
      throw new Error("Socket volume ownership changed");
    const container = await docker.createContainer({
      name,
      Image: image.Id,
      User: "1000:1000",
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      Labels: labels,
      Healthcheck: {
        Test: ["CMD", "test", "-S", DATABASE_SOCKET_PATH],
        Interval: 1_000_000_000,
        Timeout: 1_000_000_000,
        Retries: 3,
      },
      HostConfig: {
        NetworkMode: input.database.networkId,
        Memory: 64 * 1024 ** 2,
        NanoCpus: 250_000_000,
        PidsLimit: 32,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Sysctls: { "net.ipv4.ip_forward": "0" },
        Mounts: [
          { Type: "volume", Source: name, Target: DATABASE_SOCKET_DIRECTORY },
        ],
        Tmpfs: {
          "/run/wrenly-db-config":
            "rw,nosuid,nodev,size=1m,uid=1000,gid=1000,mode=0700",
          "/tmp": "rw,nosuid,nodev,size=1m",
        },
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "1m", "max-file": "1" },
        },
      },
    });
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    await container.start();
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "attach",
        "--sig-proxy=false",
        container.id,
      ],
      {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    child.stdin.write(JSON.stringify(configuration));
    child.stdin.end();
    const deadline = Date.now() + TIMEOUT_MS;
    while (true) {
      await input.fence.assertHeld();
      input.signal.throwIfAborted();
      const info = await container.inspect();
      if (!info.State.Running || Date.now() >= deadline)
        throw new Error("Socket readiness failed");
      if (info.State.Health?.Status === "healthy") break;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    }
    await input.fence.acknowledgeEffect({ kind: "create-socket", id: name });
    return {
      id: input.socketId,
      resourceId: input.scope.resourceId,
      projectId: input.scope.projectId,
      containerId: container.id,
      volumeName: name,
      imageId: image.Id,
    };
  } catch (error) {
    throw new DatabaseRuntimeError("socket preparation", error);
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
  }
}

/** Revokes one exact socket after the app/query is quiescent. Never removes the PostgreSQL data volume. */
export async function cleanupDatabaseSocket(
  identity: DatabaseSocketIdentity,
  assertHeld: () => Promise<void> = async () => {},
): Promise<void> {
  try {
    await assertHeld();
    if (
      !UUID.test(identity.id) ||
      !UUID.test(identity.resourceId) ||
      !UUID.test(identity.projectId) ||
      identity.volumeName !== `wrenly-database-socket-${identity.id}`
    )
      throw new Error("Invalid socket ownership");
    const labels = {
      "io.wrenly.database-id": identity.resourceId,
      "io.wrenly.project-id": identity.projectId,
      "io.wrenly.database-socket-id": identity.id,
      "io.wrenly.role": "database-socket",
    };
    const container = docker.getContainer(identity.containerId),
      volume = docker.getVolume(identity.volumeName);
    try {
      const info = await container.inspect();
      if (
        info.Image !== identity.imageId ||
        Object.entries(labels).some(
          ([key, value]) => info.Config.Labels?.[key] !== value,
        )
      )
        throw new Error("Socket container ownership changed");
      await assertHeld();
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
    try {
      const info = await volume.inspect();
      if (
        Object.entries(labels).some(
          ([key, value]) => info.Labels?.[key] !== value,
        )
      )
        throw new Error("Socket volume ownership changed");
      await assertHeld();
      await volume.remove();
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      ))
        throw error;
    }
  } catch {
    throw new DatabaseRuntimeError("socket cleanup");
  }
}

/** Removes a partially created socket only after the caller recorded its creation intent. */
export async function cleanupScopedDatabaseSocket(
  scope: ManagedDatabaseScope,
  socketId: string,
  assertHeld: () => Promise<void> = async () => {},
): Promise<void> {
  await assertHeld();
  if (!UUID.test(socketId))
    throw new DatabaseRuntimeError("invalid socket cleanup scope");
  // Validate every scope identifier before deriving local Docker handles.
  managedDatabaseLabels(scope, "database-socket");
  const name = `wrenly-database-socket-${socketId}`;
  let imageId = "";
  try {
    imageId = (await docker.getContainer(name).inspect()).Image;
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    ))
      throw new DatabaseRuntimeError("socket cleanup inspection");
  }
  await cleanupDatabaseSocket(
    {
      id: socketId,
      resourceId: scope.resourceId,
      projectId: scope.projectId,
      containerId: name,
      volumeName: name,
      imageId,
    },
    assertHeld,
  );
}
