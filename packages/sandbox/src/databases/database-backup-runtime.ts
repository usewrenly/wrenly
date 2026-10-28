// Captures bounded database archives or restores them into explicitly disposable resources.
// Role credentials enter through stdin; caller owns encryption/storage and durable effect records.
import Docker from "dockerode";
import {
  inspectManagedDatabase,
  inspectManagedDatabaseState,
  DatabaseRuntimeError,
  type ManagedDatabaseIdentity,
  type DatabaseRuntimeFence,
} from "./database-runtime";
import {
  managedDatabaseLabels,
  type ManagedDatabaseScope,
} from "./database-resource-policy";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
export const MAX_DATABASE_ARCHIVE_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 60_000;
interface Input {
  scope: ManagedDatabaseScope;
  database: ManagedDatabaseIdentity;
  operationId: string;
  role: { user: string; password: string };
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}
async function archiveCommand(
  input: Input,
  archive?: Uint8Array,
): Promise<Uint8Array> {
  let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const name = `wrenly-database-${archive ? "restore" : "dump"}-${input.operationId}`;
  let cleanupConfirmed = false;
  let diagnostics: Promise<string> | undefined;
  const stop = (): void => {
    child?.kill("SIGKILL");
  };
  try {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        input.operationId,
      ) ||
      input.role.user !==
        `wrenly_${input.scope.resourceId.replaceAll("-", "")}_migrate` ||
      !/^[a-f0-9]{64}$/.test(input.role.password) ||
      (archive &&
        (input.scope.resourceId !== input.operationId ||
          !archive.byteLength ||
          archive.byteLength > MAX_DATABASE_ARCHIVE_BYTES ||
          Buffer.from(archive.subarray(0, 5)).toString() !== "PGDMP"))
    )
      throw new Error("Invalid archive request");
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    if (
      (await inspectManagedDatabaseState(input.scope, input.database)) !==
      "ready"
    )
      throw new Error("Database is not ready");
    const upstream = await inspectManagedDatabase(input.scope, input.database);
    try {
      await docker.getContainer(name).inspect();
      throw new Error("Existing archive helper requires recovery");
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      ))
        throw error;
    }
    await input.fence.beforeEffect({
      kind: archive ? "restore-backup" : "capture-backup",
      id: name,
    });
    await input.fence.assertHeld();
    // The migrator owns public but cannot CREATE schemas/databases. Keep the
    // pre-provisioned schema and omit only its archive creation entry.
    const prefix =
      'IFS= read -r PGPASSWORD; test "${#PGPASSWORD}" -eq 64; export PGPASSWORD; ';
    const connection = ' --host "$1" --port 5432 --username "$2" --dbname app';
    const script = archive
      ? prefix +
        `cat >/tmp/archive; pg_restore --list /tmp/archive | awk '$4 != "SCHEMA" || $6 != "public"' >/tmp/restore.list; exec pg_restore --exit-on-error --single-transaction --no-owner --no-acl --use-list=/tmp/restore.list` +
        connection +
        " /tmp/archive"
      : prefix +
        "exec pg_dump --format=custom --compress=0 --lock-wait-timeout=5000 --no-owner --no-acl --schema=public --large-objects" +
        connection;
    const labels = {
      ...managedDatabaseLabels(input.scope, "database-backup"),
      "io.wrenly.database-operation-id": input.operationId,
    };
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "run",
        "--name",
        name,
        "--network",
        input.database.networkId,
        "--user",
        "70:70",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--memory",
        "128m",
        "--cpus",
        "0.5",
        "--pids-limit",
        "32",
        "--log-driver",
        "none",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=64m",
        "--interactive",
        ...Object.entries(labels).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
        "--entrypoint",
        "sh",
        input.database.imageId,
        "-ec",
        script,
        "sh",
        upstream.address,
        input.role.user,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    diagnostics = (async () => {
      if (!child) return "unknown";
      const reader = child.stderr.getReader();
      let text = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (text.length < 4096)
            text += new TextDecoder().decode(
              part.value.subarray(0, 4096 - text.length),
            );
        }
      } finally {
        reader.releaseLock();
      }
      if (text.includes('schema "public" already exists'))
        return "public-schema-exists";
      if (text.includes("permission denied")) return "permission-denied";
      if (text.includes("must be owner")) return "ownership-denied";
      if (text.includes("could not read")) return "archive-read-failed";
      return "unclassified-helper-failure";
    })();
    timer = setTimeout(stop, DEADLINE_MS);
    input.signal.addEventListener("abort", stop, { once: true });
    child.stdin.write(input.role.password + "\n");
    if (archive) child.stdin.write(archive);
    await child.stdin.flush();
    child.stdin.end();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > (archive ? 1024 : MAX_DATABASE_ARCHIVE_BYTES))
          throw new Error("Archive output limit");
        chunks.push(part.value);
        await input.fence.assertHeld();
        input.signal.throwIfAborted();
      }
    } finally {
      reader.releaseLock();
    }
    if ((await child.exited) !== 0)
      throw new Error(`Archive command failed: ${await diagnostics}`);
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const info = await docker.getContainer(name).inspect();
    if (
      info.State.ExitCode !== 0 ||
      info.Config.Labels?.["io.wrenly.database-id"] !==
        input.scope.resourceId ||
      info.HostConfig.LogConfig?.Type !== "none"
    )
      throw new Error("Archive helper identity changed");
    await docker.getContainer(info.Id).remove({ v: true });
    cleanupConfirmed = true;
    await input.fence.acknowledgeEffect({
      kind: archive ? "restore-backup" : "capture-backup",
      id: name,
    });
    const bytes = Buffer.concat(chunks);
    if (!archive && bytes.subarray(0, 5).toString() !== "PGDMP")
      throw new Error("Invalid archive format");
    return bytes;
  } catch (error) {
    throw new DatabaseRuntimeError(
      archive ? "backup restore verification" : "backup capture",
      error,
    );
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await diagnostics?.catch(() => undefined);
    if (child && !cleanupConfirmed) {
      try {
        const info = await docker.getContainer(name).inspect();
        if (
          info.Config.Labels?.["io.wrenly.database-id"] ===
            input.scope.resourceId &&
          info.Config.Labels?.["io.wrenly.project-id"] ===
            input.scope.projectId &&
          info.Config.Labels?.["io.wrenly.database-operation-id"] ===
            input.operationId &&
          info.Config.Labels?.["io.wrenly.role"] === "database-backup"
        )
          await docker.getContainer(info.Id).remove({ force: true, v: true });
      } catch {
        /* Durable intent remains unresolved if creation/cleanup cannot be confirmed. */
      }
    }
  }
}
/** Dumps one consistent public-schema custom archive through a trusted bounded helper. */
export async function captureManagedDatabaseBackup(
  input: Input,
): Promise<Uint8Array> {
  return archiveCommand(input);
}
/** Internal verification only: caller must supply a fresh disposable target, never live application data. */
export async function restoreDisposableDatabaseBackup(
  input: Input & { archive: Uint8Array },
): Promise<void> {
  await archiveCommand(input, input.archive);
}
