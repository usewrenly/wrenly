/** Disposable native TLS acceptance. No existing Wrenly resource is read or modified. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Docker from "dockerode";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { createProductionProjectCredentials } from "@wrenly/db/production-project-credentials";
import {
  createProductionProjectRoles,
  createProductionProjectDatabase,
  enableProductionProjectConnections,
  initializeProductionProjectSchema,
} from "@wrenly/db/production-project-provisioning";
import {
  startProductionDatabaseSocket,
  cleanupDatabaseSocket,
  type DatabaseSocketIdentity,
} from "../src/databases/database-socket";
const acceptance =
  process.env.WRENLY_TEST_PRODUCTION_SOCKET === "true" ? test : test.skip;
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const scope = {
  resourceId: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  environment: "production" as const,
};
const credentials = createProductionProjectCredentials(scope.resourceId);
const fixtureName = `wrenly-production-socket-test-${scope.resourceId}`;
const sockets: DatabaseSocketIdentity[] = [];
const socketIds: string[] = [];
let directory: string, networkId: string, address: string, authority: string;
let management: ReturnType<typeof postgres> | undefined;
const effects: string[] = [];
async function command(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin) {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [output, errors, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(
      `Disposable acceptance command failed: ${args[0]}: ${errors.slice(0, 500)}`,
    );
  return output.trim();
}
beforeAll(async () => {
  if (process.env.WRENLY_TEST_PRODUCTION_SOCKET !== "true") return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-production-socket-"));
  await command([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(directory, "server.key"),
    "-out",
    join(directory, "server.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=production.internal.test",
    "-addext",
    "subjectAltName=DNS:production.internal.test",
  ]);
  authority = await readFile(join(directory, "server.crt"), "utf8");
  const network = await docker.createNetwork({
    Name: fixtureName,
    Driver: "bridge",
    Labels: {
      "io.wrenly.database-id": scope.resourceId,
      "io.wrenly.project-id": scope.projectId,
      "io.wrenly.database-environment": "production",
    },
  });
  networkId = network.id;
  await command([
    "docker",
    "run",
    "-d",
    "--name",
    fixtureName,
    "--network",
    networkId,
    "-p",
    "127.0.0.1::5432",
    "-e",
    "POSTGRES_PASSWORD=fixture-only",
    "-e",
    "POSTGRES_DB=maintenance",
    "-v",
    `${directory}:/fixture:ro`,
    "--entrypoint",
    "sh",
    "postgres:17-alpine",
    "-c",
    "cp /fixture/server.key /tmp/server.key && cp /fixture/server.crt /tmp/server.crt && chmod 600 /tmp/server.key && chown postgres:postgres /tmp/server.key /tmp/server.crt && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
  ]);
  const info = await docker.getContainer(fixtureName).inspect();
  address = Object.values(info.NetworkSettings.Networks)[0]!.IPAddress;
  const port = Number(info.NetworkSettings.Ports["5432/tcp"]![0]!.HostPort);
  management = postgres({
    host: "127.0.0.1",
    port,
    database: "maintenance",
    user: "postgres",
    password: "fixture-only",
    ssl: {
      ca: authority,
      servername: "production.internal.test",
      rejectUnauthorized: true,
    },
    max: 1,
    connect_timeout: 2,
    prepare: false,
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await drizzle(management).execute(sql`select 1`);
      ready = true;
      break;
    } catch {
      await Bun.sleep(250);
    }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  const database = drizzle(management);
  const rows = await database.execute(
    sql`select system_identifier::text as id from pg_catalog.pg_control_system()`,
  );
  const identity = { appClusterId: String(rows[0]!.id), controlClusterId: "1" };
  await createProductionProjectRoles(
    database,
    identity,
    scope.resourceId,
    credentials,
  );
  await createProductionProjectDatabase(
    database,
    identity,
    scope.resourceId,
    credentials,
  );
  await enableProductionProjectConnections(
    database,
    identity,
    scope.resourceId,
    credentials,
  );
  const projectClient = postgres({
    host: "127.0.0.1",
    port,
    database: credentials.database,
    user: "postgres",
    password: "fixture-only",
    ssl: {
      ca: authority,
      servername: "production.internal.test",
      rejectUnauthorized: true,
    },
    max: 1,
  });
  try {
    await initializeProductionProjectSchema(
      drizzle(projectClient),
      identity,
      scope.resourceId,
      credentials,
    );
    await drizzle(projectClient).execute(
      sql`set role ${sql.identifier(credentials.migrator.user)}`,
    );
    await drizzle(projectClient).execute(
      sql`create table public.notes(id serial primary key, body text not null)`,
    );
    await drizzle(projectClient).execute(sql`reset role`);
  } finally {
    await projectClient.end({ timeout: 1 });
  }
}, 45_000);
afterAll(async () => {
  for (const socket of sockets) await cleanupDatabaseSocket(socket);
  // A failed startup still belongs to this test; remove only its exact randomly generated names.
  for (const id of socketIds) {
    const name = `wrenly-database-socket-${id}`;
    await docker
      .getContainer(name)
      .remove({ force: true })
      .catch(() => {});
    await docker
      .getVolume(name)
      .remove()
      .catch(() => {});
  }
  await management?.end({ timeout: 1 });
  await docker
    .getContainer(fixtureName)
    .remove({ force: true, v: true })
    .catch(() => {});
  if (networkId) await docker.getNetwork(networkId).remove();
  if (directory) await rm(directory, { recursive: true, force: true });
});
acceptance(
  "isolated client authenticates through Unix socket and verified TLS; wrong hostname never falls back",
  async () => {
    for (const valid of [true, false]) {
      const id = crypto.randomUUID();
      socketIds.push(id);
      let verificationCount = 0;
      const socket = await startProductionDatabaseSocket({
        scope,
        socketId: id,
        networkId,
        upstream: {
          hostname: valid ? "production.internal.test" : "wrong.internal.test",
          address,
          port: 5432,
        },
        credentials,
        role: "runtime",
        certificateAuthority: authority,
        signal: AbortSignal.timeout(30_000),
        verifyTarget: async () => {
          verificationCount++;
        },
        fence: {
          assertHeld: async () => {},
          beforeEffect: async (effect) => {
            effects.push(`intent:${effect.id}`);
          },
          acknowledgeEffect: async (effect) => {
            effects.push(`ack:${effect.id}`);
          },
        },
      });
      sockets.push(socket);
      // The toolchain has Bun but no app dependencies. psql from the PostgreSQL fixture image reads its password over stdin only.
      const result = await command(
        [
          "docker",
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "-v",
          `${socket.volumeName}:/run/wrenly-database`,
          "--entrypoint",
          "sh",
          "postgres:17-alpine",
          "-c",
          `read -r PGPASSWORD; export PGPASSWORD; export PGCONNECT_TIMEOUT=5; exec psql -h /run/wrenly-database -p 6432 -U "$1" -d app -qtAc "insert into public.notes(body) values ('saved'); update public.notes set body='updated'; select body from public.notes; delete from public.notes;"`,
          "sh",
          credentials.runtime.user,
        ],
        credentials.runtime.password + "\n",
      ).then(
        (output) => ({ ok: true, output }),
        () => ({ ok: false, output: "" }),
      );
      expect(result.ok).toBe(valid);
      if (valid) expect(result.output).toBe("updated");
      expect(verificationCount).toBe(2);
      const inspection = await docker
        .getContainer(socket.containerId)
        .inspect();
      expect(inspection.HostConfig.ExtraHosts).toContain(
        `${valid ? "production.internal.test" : "wrong.internal.test"}:${address}`,
      );
      expect(JSON.stringify(inspection.Config.Env)).not.toContain(
        credentials.runtime.password,
      );
      expect(inspection.HostConfig.PortBindings ?? {}).toEqual({});
    }
    expect(effects.length).toBe(4);
  },
  60_000,
);
