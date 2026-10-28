// Runs repository-owned role/schema administration bundles against a verified database.
// Caller-saved intent and acknowledgement fence trusted DDL; generated SQL is not accepted here.
import Docker from "dockerode";
import type { AppDatabaseSessionTarget } from "@wrenly/db/app-database-runtime-contract";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  inspectManagedDatabase,
  DatabaseRuntimeError,
  type ManagedDatabaseIdentity,
  type DatabaseRuntimeFence,
} from "./database-runtime";
import {
  managedDatabaseLabels,
  type ManagedDatabaseScope,
} from "./database-resource-policy";
import { DATABASE_SOCKET_IMAGE } from "./database-socket";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 8192;
const DEADLINE_MS = 20_000;
const POLL_MS = 100;
const READY = "WRENLY_DATABASE_ROLES_READY_V1";
async function removeAdministrator(
  container: Docker.Container,
  resourceId: string,
  projectId: string,
  operationId: string,
): Promise<boolean> {
  try {
    const info = await container.inspect();
    if (
      info.Config.Labels?.["io.wrenly.database-id"] !== resourceId ||
      info.Config.Labels?.["io.wrenly.project-id"] !== projectId ||
      info.Config.Labels?.["io.wrenly.database-operation-id"] !== operationId ||
      info.Config.Labels?.["io.wrenly.role"] !== "database-administrator"
    )
      return false;
    await container.remove({ force: true, v: true });
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    );
  }
}

/** Caller supplies the trusted API-build bundle, never generated source. Uncertain DDL keeps its durable intent. */
async function runDatabaseAdministrator(input: {
  scope: ManagedDatabaseScope;
  database: ManagedDatabaseIdentity;
  operationId: string;
  credentials: unknown;
  administratorBundle: Uint8Array;
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
  mode?:
    "inspect" | "enforce-policy" | "terminate-reader" | "terminate-migrator" | "terminate-runtime";
}): Promise<string | undefined> {
  let directory: string | undefined,
    child: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
  let container: Docker.Container | undefined;
  let cleaned = true;
  let failed = false,
    failure: unknown;
  let schemaDigest: string | undefined;
  try {
    if (
      !UUID.test(input.operationId) ||
      !input.administratorBundle.byteLength ||
      input.administratorBundle.byteLength > MAX_BUNDLE_BYTES
    )
      throw new Error("Invalid administrator bundle");
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const upstream = await inspectManagedDatabase(input.scope, input.database);
    const request = JSON.stringify({
      resourceId: input.scope.resourceId,
      address: upstream.address,
      credentials:
        input.mode === "inspect" &&
        input.credentials &&
        typeof input.credentials === "object" &&
        "migrator" in input.credentials
          ? { migrator: input.credentials.migrator }
          : input.credentials,
      ...(input.mode ? { mode: input.mode } : {}),
    });
    if (Buffer.byteLength(request) > MAX_INPUT_BYTES)
      throw new Error("Invalid administrator request size");
    const image = await docker.getImage(DATABASE_SOCKET_IMAGE).inspect();
    if (
      !/^sha256:[a-f0-9]{64}$/.test(image.Id) ||
      image.Config.User !== "1000:1000"
    )
      throw new Error("Invalid trusted helper image");
    const name = `wrenly-database-administrator-${input.operationId}`;
    const labels = {
      ...managedDatabaseLabels(input.scope, "database-administrator"),
      "io.wrenly.database-operation-id": input.operationId,
    };
    try {
      await docker.getContainer(name).inspect();
      throw new Error("Existing administrator requires reconciliation");
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "statusCode" in error &&
        error.statusCode === 404
      ))
        throw error;
    }
    directory = await mkdtemp(join(tmpdir(), "wrenly-database-administrator-"));
    const bundlePath = join(directory, "administrator.js");
    await writeFile(bundlePath, input.administratorBundle, {
      mode: 0o644,
      flag: "wx",
    });
    await input.fence.beforeEffect({
      kind:
        input.mode === "inspect"
          ? "inspect-schema"
          : input.mode === "enforce-policy"
            ? "enforce-policy"
            : input.mode === "terminate-reader" ||
                input.mode === "terminate-migrator" || input.mode === "terminate-runtime"
              ? "terminate-sessions"
              : "provision-roles",
      id: name,
    });
    await input.fence.assertHeld();
    cleaned = false;
    container = await docker.createContainer({
      name,
      Image: image.Id,
      User: "65534:65534",
      Entrypoint: ["bun", "--no-env-file", "/wrenly/administrator.js"],
      Labels: labels,
      OpenStdin: true,
      StdinOnce: true,
      AttachStdin: true,
      HostConfig: {
        NetworkMode: input.database.networkId,
        Memory: 128 * 1024 ** 2,
        NanoCpus: 500_000_000,
        PidsLimit: 32,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        Sysctls: { "net.ipv4.ip_forward": "0" },
        Mounts: [
          {
            Type: "bind",
            Source: bundlePath,
            Target: "/wrenly/administrator.js",
            ReadOnly: true,
          },
        ],
        Tmpfs: { "/tmp": "rw,nosuid,nodev,size=8m" },
        LogConfig: {
          Type: "json-file",
          Config: { "max-size": "16k", "max-file": "1" },
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
    child.stdin.write(request);
    child.stdin.end();
    const deadline = Date.now() + DEADLINE_MS;
    while (true) {
      await input.fence.assertHeld();
      input.signal.throwIfAborted();
      const state = (await container.inspect()).State;
      if (!state.Running) {
        if (state.ExitCode !== 0)
          throw new Error("Administrator refused configuration");
        break;
      }
      if (Date.now() >= deadline)
        throw new Error("Administrator deadline expired");
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS));
    }
    const logs = await container.logs({ stdout: true, stderr: false, tail: 2 });
    if (input.mode === "inspect") {
      schemaDigest = /WRENLY_DATABASE_SCHEMA_V1:([a-f0-9]{64})/.exec(
        logs.toString(),
      )?.[1];
      if (!schemaDigest) throw new Error("Schema inspection was not confirmed");
    } else if (!logs.toString().includes(READY))
      throw new Error("Administrator result was not confirmed");
    await input.fence.assertHeld();
    await container.remove({ v: true });
    cleaned = true;
    await input.fence.acknowledgeEffect({
      kind:
        input.mode === "inspect"
          ? "inspect-schema"
          : input.mode === "enforce-policy"
            ? "enforce-policy"
            : input.mode === "terminate-reader" ||
                input.mode === "terminate-migrator" || input.mode === "terminate-runtime"
              ? "terminate-sessions"
              : "provision-roles",
      id: name,
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (child?.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    if (!cleaned) {
      const name = `wrenly-database-administrator-${input.operationId}`;
      const resource = container ?? docker.getContainer(name);
      cleaned = await removeAdministrator(
        resource,
        input.scope.resourceId,
        input.scope.projectId,
        input.operationId,
      );
    }
    if (cleaned && directory)
      await rm(directory, { recursive: true, force: true });
  }
  if (!cleaned) throw new DatabaseRuntimeError("administrator cleanup");
  if (failed)
    throw new DatabaseRuntimeError(
      input.mode === "inspect"
        ? "schema inspection"
        : input.mode === "enforce-policy"
          ? "role policy"
          : "role provisioning",
      failure,
    );
  return schemaDigest;
}

type AdministratorInput = Omit<
  Parameters<typeof runDatabaseAdministrator>[0],
  "mode"
>;
/** Provisions fixed application roles once; never adopts an existing schema. */
export async function provisionManagedDatabaseRoles(
  input: AdministratorInput,
): Promise<void> {
  await runDatabaseAdministrator(input);
}
/** Executes only fixed read-only catalog/journal queries and returns their digest, never rows. */
export async function inspectManagedDatabaseSchema(
  input: AdministratorInput,
): Promise<string> {
  const digest = await runDatabaseAdministrator({ ...input, mode: "inspect" });
  if (!digest) throw new DatabaseRuntimeError("missing schema inspection");
  return digest;
}

/** Reapplies the reviewed runtime/reader policy and protects migration journals. */
export async function enforceManagedDatabaseRolePolicy(
  input: AdministratorInput,
): Promise<void> {
  await runDatabaseAdministrator({ ...input, mode: "enforce-policy" });
}

/** Stop the selected role's clients and broker first; a runtime target additionally requires exclusive stopped-preview ownership. */
export async function terminateManagedDatabaseSessions(
  input: AdministratorInput & { target: AppDatabaseSessionTarget },
): Promise<void> {
  if (input.target !== "reader" && input.target !== "migrator" && input.target !== "runtime")
    throw new DatabaseRuntimeError("invalid session termination target");
  await runDatabaseAdministrator({
    ...input,
    mode: input.target === "reader" ? "terminate-reader" : input.target === "migrator" ? "terminate-migrator" : "terminate-runtime",
  });
}
