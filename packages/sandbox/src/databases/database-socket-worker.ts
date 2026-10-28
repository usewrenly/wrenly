// Runs trusted query/migration bundles through one authenticated Unix socket.
// Generated client containers retain blocked IP egress; caller intent/lease fences every effect.
import Docker from "dockerode";
import { ARTIFACT_WORKSPACE_LABEL, ARTIFACT_WORKSPACE_VERSION } from "../artifacts/artifact-policy";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { validateFilePaths } from "../source-policy/file-paths";
import {
  DATABASE_SOCKET_DIRECTORY,
  managedDatabaseLabels,
  type ManagedDatabaseScope,
} from "./database-resource-policy";
import {
  DatabaseRuntimeError,
  type DatabaseRuntimeFence,
} from "./database-runtime";
import type { DatabaseSocketIdentity } from "./database-socket";
// Queries are short reads; reviewed migrations get a longer bounded execution window.
const QUERY_TIMEOUT_MS = 15_000;
const MIGRATION_TIMEOUT_MS = 65_000;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024,
  MAX_INPUT_BYTES = 65536,
  MAX_OUTPUT_BYTES = 128 * 1024,
  MAX_SOURCE_BYTES = 2 * 1024 * 1024;
/** Runs only a server-built helper; no generated command, network destination or browser-supplied bundle is accepted. */
export async function runDatabaseSocketWorker(input: {
  kind: "query" | "migration";
  scope: ManagedDatabaseScope;
  socket: DatabaseSocketIdentity;
  operationId: string;
  request: { resourceId: string; user: string; password: string } & Record<
    string,
    unknown
  >;
  bundle: Uint8Array;
  /** Internal prepared Laravel artifact; never a browser-selected image. */
  laravel?: { imageId: string; preparationId: string };
  files?: Array<{ path: string; content: string }>;
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
}): Promise<unknown> {
  let directory: string | undefined,
    child: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  let started = false,
    cleaned: boolean,
    result: unknown,
    failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const name = `wrenly-database-${input.kind}-${input.operationId}`;
  const effect = {
    kind:
      input.kind === "query"
        ? ("read-database" as const)
        : ("apply-migrations" as const),
    id: name,
  };
  const stop = (): void => {
    child?.kill("SIGKILL");
  };
  const labels = {
    ...managedDatabaseLabels(
      input.scope,
      input.kind === "query" ? "database-query" : "database-migration",
    ),
    "io.wrenly.database-operation-id": input.operationId,
  };
  try {
    if (
      !UUID.test(input.operationId) ||
      !UUID.test(input.socket.id) ||
      !/^sha256:[a-f0-9]{64}$/.test(input.socket.imageId) ||
      input.socket.resourceId !== input.scope.resourceId ||
      input.socket.projectId !== input.scope.projectId ||
      input.socket.volumeName !== `wrenly-database-socket-${input.socket.id}` ||
      input.request.resourceId !== input.scope.resourceId ||
      input.request.user !==
        `wrenly_${input.scope.resourceId.replaceAll("-", "")}_${input.kind === "query" ? "reader" : "migrate"}` ||
      !/^[a-f0-9]{64}$/.test(input.request.password) ||
      (!input.laravel && !input.bundle.byteLength) ||
      input.bundle.byteLength > MAX_BUNDLE_BYTES
    )
      throw new Error("Invalid private socket helper identity");
    let executionImage = input.socket.imageId;
    if (input.laravel) {
      if (input.kind !== "migration" || input.laravel.preparationId !== input.operationId || !UUID.test(input.laravel.preparationId) ||
        !/^sha256:[a-f0-9]{64}$/.test(input.laravel.imageId) || input.files?.length)
        throw new Error("Invalid Laravel migration artifact");
      const prepared = await docker.getImage(input.laravel.imageId).inspect();
      if (prepared.Id !== input.laravel.imageId || prepared.Config.User !== "1000:1000" ||
        prepared.Config.Labels?.["io.wrenly.deployment-id"] !== input.laravel.preparationId ||
        prepared.Config.Labels?.["io.wrenly.artifact-role"] !== "runtime" ||
        prepared.Config.Labels?.[ARTIFACT_WORKSPACE_LABEL] !== ARTIFACT_WORKSPACE_VERSION)
        throw new Error("Laravel migration artifact ownership changed");
      executionImage = prepared.Id;
    }
    const request = JSON.stringify(input.request);
    if (Buffer.byteLength(request) > MAX_INPUT_BYTES)
      throw new Error("Helper input exceeds bounds");
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const [socket, volume, image] = await Promise.all([
      docker.getContainer(input.socket.containerId).inspect(),
      docker.getVolume(input.socket.volumeName).inspect(),
      docker.getImage(input.socket.imageId).inspect(),
    ]);
    const socketLabels = {
      ...managedDatabaseLabels(input.scope, "database-socket"),
      "io.wrenly.database-socket-id": input.socket.id,
    };
    if (
      volume.Driver !== "local" ||
      Object.keys(volume.Options ?? {}).length > 0 ||
      !socket.State.Running ||
      socket.Image !== input.socket.imageId ||
      image.Id !== input.socket.imageId ||
      image.Config.User !== "1000:1000" ||
      Object.entries(socketLabels).some(
        ([key, value]) =>
          socket.Config.Labels?.[key] !== value ||
          volume.Labels?.[key] !== value,
      )
    )
      throw new Error("Socket ownership or helper image changed");
    try {
      await docker.getContainer(name).inspect();
      throw new Error("Existing helper requires recovery");
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      ))
        throw error;
    }
    directory = await mkdtemp(join(tmpdir(), "wrenly-database-worker-"));
    const bundlePath = join(directory, "worker.js"),
      workspace = join(directory, "source");
    await writeFile(bundlePath, input.bundle, { flag: "wx", mode: 0o644 });
    await mkdir(workspace, { mode: 0o755 });
    const files = input.files ?? [];
    validateFilePaths(files);
    if (
      files.length > 1000 ||
      Buffer.byteLength(JSON.stringify(files)) > MAX_SOURCE_BYTES
    )
      throw new Error("Frozen helper source exceeds bounds");
    for (const file of files) {
      const path = join(workspace, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o755 });
      await writeFile(path, file.content, { flag: "wx", mode: 0o644 });
    }
    await input.fence.beforeEffect(effect);
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    started = true;
    child = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "run",
        "--name",
        name,
        "--interactive",
        "--sig-proxy=false",
        "--network",
        "none",
        "--read-only",
        "--user",
        input.laravel ? "0:0" : "65534:65534",
        "--cap-drop=ALL",
        ...(input.laravel ? ["--cap-add=SETUID", "--cap-add=SETGID"] : []),
        "--security-opt=no-new-privileges:true",
        input.laravel ? "--memory=512m" : "--memory=128m",
        "--cpus=0.5",
        "--pids-limit=32",
        "--log-driver",
        "none",
        ...Object.entries(labels).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
        ...(input.laravel ? [
          "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m",
          "--tmpfs", "/app/bootstrap/cache:rw,nosuid,nodev,size=8m,uid=1000,gid=1000",
          "--tmpfs", "/app/storage:rw,nosuid,nodev,size=16m,uid=1000,gid=1000",
        ] : [
          "--mount", `type=bind,source=${bundlePath},target=/wrenly/worker.js,readonly`,
          "--mount", `type=bind,source=${workspace},target=/app,readonly`,
        ]),
        "--mount",
        `type=volume,source=${input.socket.volumeName},target=${DATABASE_SOCKET_DIRECTORY},readonly`,
        "--entrypoint",
        "bun",
        executionImage,
        ...(input.laravel ? ["--no-env-file", "/wrenly/migration-watchdog.ts"] : ["--no-env-file", "/wrenly/worker.js"]),
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    timer = setTimeout(stop, input.kind === "query" ? QUERY_TIMEOUT_MS : MIGRATION_TIMEOUT_MS);
    input.signal.addEventListener("abort", stop, { once: true });
    child.stdin.write(request);
    await child.stdin.flush();
    child.stdin.end();
    const reader = child.stdout.getReader(),
      chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES)
          throw new Error("Helper output exceeds bounds");
        chunks.push(part.value);
        await input.fence.assertHeld();
        input.signal.throwIfAborted();
      }
    } finally {
      reader.releaseLock();
    }
    if ((await child.exited) !== 0) throw new Error("Database helper failed");
    const output = Buffer.concat(chunks).toString("utf8");
    if (input.kind === "query") result = JSON.parse(output) as unknown;
    else if (output.trim() !== "WRENLY_DATABASE_MIGRATIONS_APPLIED_V1")
      throw new Error("Migration completion not confirmed");
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
  } catch {
    failed = true;
  } finally {
    if (timer) clearTimeout(timer);
    input.signal.removeEventListener("abort", stop);
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (started) {
      try {
        const container = docker.getContainer(name),
          info = await container.inspect();
        const owned = Object.entries(labels).every(
          ([key, value]) => info.Config.Labels?.[key] === value,
        );
        if (owned) {
          await container.remove({ force: true, v: true });
          cleaned = true;
        } else cleaned = false;
      } catch (error) {
        cleaned =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          error.statusCode === 404;
      }
    } else cleaned = true;
    if (cleaned && directory)
      await rm(directory, { recursive: true, force: true });
  }
  if (!cleaned) throw new DatabaseRuntimeError("socket helper cleanup");
  if (failed)
    throw new DatabaseRuntimeError(
      input.kind === "query" ? "read-only query" : "reviewed migration",
    );
  await input.fence.acknowledgeEffect(effect);
  return result;
}
