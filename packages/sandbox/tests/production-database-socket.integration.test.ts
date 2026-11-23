import { inspectAppDatabaseSchema } from "@wrenly/db/app-database-catalog";
import { terminateProductionDatabaseSessions } from "@wrenly/db/app-database-roles";
import { cleanupProductionOperationClients } from "../src/databases/database-operation-cleanup";
import { inspectRuntimeHost } from "../../../apps/api/src/modules/databases/production-targets/deployment-hosts/helper";
import { executeRuntimeVolumeRequest } from "../../../apps/api/src/modules/databases/production-targets/deployment-hosts/volumes";
import { executeRuntimeNetworkRequest } from "../../../apps/api/src/modules/databases/production-targets/deployment-hosts/network";
import { createRuntimeDatabaseBroker } from "../../../apps/api/src/modules/databases/production-targets/deployment-hosts/broker";
import { startRuntimeApplication } from "../../../apps/api/src/modules/databases/production-targets/deployment-hosts/application-start";
import { findRuntimeIngress } from "../../../apps/api/src/modules/databases/production-targets/deployment-hosts/ingress-inspection";
/** Disposable native TLS acceptance. No existing Wrenly resource is read or modified. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Docker from "dockerode";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import {
  captureProductionDatabaseBackup,
  restoreDisposableDatabaseBackup,
} from "../src/databases/database-backup-runtime";
import {
  createManagedDatabase,
  cleanupDisposableDatabase,
} from "../src/databases/database-runtime";
import { provisionManagedDatabaseRoles } from "../src/databases/database-administrator";
import { createDatabaseCredentials } from "../../../apps/api/src/modules/databases/database-contract";
import { getDatabaseWorkerBundle } from "../../../apps/api/src/modules/databases/database-worker-bundle";
import { runDatabaseSocketWorker } from "../src/databases/database-socket-worker";
import { cleanupScopedDatabaseSocket } from "../src/databases/database-socket";
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
let publishingAddress: string, publishingPort: number;
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
  const fixtureNetwork = await network.inspect();
  publishingAddress = fixtureNetwork.IPAM.Config[0]!.Gateway!;
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
    "-p",
    `${publishingAddress}::5432`,
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
  const ports = info.NetworkSettings.Ports["5432/tcp"]!;
  const port = Number(
    ports.find((binding) => binding.HostIp === "127.0.0.1")!.HostPort,
  );
  publishingPort = Number(
    ports.find((binding) => binding.HostIp === publishingAddress)!.HostPort,
  );
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

acceptance(
  "Production reader and backup use network-isolated helpers; archive restores separately",
  async () => {
    const fence = {
      assertHeld: async (): Promise<void> => {},
      beforeEffect: async (effect: { id: string }): Promise<void> => {
        effects.push(`intent:${effect.id}`);
      },
      acknowledgeEffect: async (effect: { id: string }): Promise<void> => {
        effects.push(`ack:${effect.id}`);
      },
    };
    const signal = AbortSignal.timeout(90_000);
    const opened: DatabaseSocketIdentity[] = [];
    const temporaryId = crypto.randomUUID();
    const temporaryScope = {
      ...scope,
      resourceId: temporaryId,
      environment: "development" as const,
    };
    let temporaryStarted = false;
    try {
      for (const role of ["reader", "migrator"] as const) {
        const socketId = crypto.randomUUID();
        socketIds.push(socketId);
        const socket = await startProductionDatabaseSocket({
          scope,
          socketId,
          networkId,
          upstream: {
            hostname: "production.internal.test",
            address,
            port: 5432,
          },
          credentials,
          role,
          certificateAuthority: authority,
          fence,
          signal,
          verifyTarget: async () => {},
        });
        opened.push(socket);
      }
      const reader = opened[0]!,
        migrator = opened[1]!;
      const viewed = await runDatabaseSocketWorker({
        kind: "query",
        scope,
        socket: reader,
        operationId: crypto.randomUUID(),
        request: {
          resourceId: scope.resourceId,
          ...credentials.reader,
          rows: false,
        },
        bundle: await getDatabaseWorkerBundle("query"),
        fence,
        signal,
      });
      expect(JSON.stringify(viewed)).toContain("notes");
      await expect(
        cleanupScopedDatabaseSocket(
          { ...scope, environment: "development" },
          reader.id,
        ),
      ).rejects.toThrow();
      await command(
        [
          "docker",
          "run",
          "--rm",
          "-i",
          "--network",
          "none",
          "-v",
          `${migrator.volumeName}:/run/wrenly-database`,
          "--entrypoint",
          "sh",
          "postgres:17-alpine",
          "-c",
          'read -r PGPASSWORD; export PGPASSWORD; exec psql -h /run/wrenly-database -p 6432 -U "$1" -d app -qtAc "insert into public.notes(body) values (\'preserved booking\')"',
          "sh",
          credentials.migrator.user,
        ],
        credentials.migrator.password + "\n",
      );
      const archive = await captureProductionDatabaseBackup({
        scope,
        socket: migrator,
        operationId: crypto.randomUUID(),
        role: credentials.migrator,
        fence,
        signal,
      });
      expect(Buffer.from(archive.subarray(0, 5)).toString()).toBe("PGDMP");
      await expect(
        captureProductionDatabaseBackup({
          scope: { ...scope, projectId: crypto.randomUUID() },
          socket: migrator,
          operationId: crypto.randomUUID(),
          role: credentials.migrator,
          fence,
          signal,
        }),
      ).rejects.toThrow();
      const temporaryCredentials = createDatabaseCredentials(temporaryId);
      temporaryStarted = true;
      const database = await createManagedDatabase({
        scope: temporaryScope,
        operationId: temporaryId,
        administrator: temporaryCredentials.administrator,
        fence,
        signal,
      });
      await provisionManagedDatabaseRoles({
        scope: temporaryScope,
        database,
        operationId: temporaryId,
        credentials: temporaryCredentials,
        administratorBundle: await getDatabaseWorkerBundle("administrator"),
        fence,
        signal,
      });
      await restoreDisposableDatabaseBackup({
        scope: temporaryScope,
        database,
        operationId: temporaryId,
        role: temporaryCredentials.migrator,
        fence,
        signal,
        archive,
      });
      const info = await docker.getContainer(database.containerId).inspect();
      const upstream = Object.values(info.NetworkSettings.Networks)[0]!
        .IPAddress;
      const restored = await command(
        [
          "docker",
          "run",
          "--rm",
          "-i",
          "--network",
          database.networkId,
          "--entrypoint",
          "sh",
          database.imageId,
          "-c",
          'read -r PGPASSWORD; export PGPASSWORD; exec psql -h "$1" -U "$2" -d app -qtAc "select body from public.notes"',
          "sh",
          upstream,
          temporaryCredentials.reader.user,
        ],
        temporaryCredentials.reader.password + "\n",
      );
      expect(restored).toBe("preserved booking");
      // The same canonical inspector used by recovery includes native migration
      // history while excluding row values. Cleanup must preserve both records and schema.
      const projectClient = postgres({
        host: "127.0.0.1",
        port: publishingPort,
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
        const original = drizzle(projectClient);
        const digest = await inspectAppDatabaseSchema(original);
        const rows = await original.execute(
          sql`select system_identifier::text as id from pg_catalog.pg_control_system()`,
        );
        await terminateProductionDatabaseSessions(
          original,
          { appClusterId: String(rows[0]!.id), controlClusterId: "1" },
          scope.resourceId,
          credentials,
          "migrator",
        );
        await cleanupProductionOperationClients({
          projectId: scope.projectId,
          resourceId: scope.resourceId,
          operationId: crypto.randomUUID(),
          assertHeld: async () => {},
        });
        expect(await inspectAppDatabaseSchema(original)).toBe(digest);
        expect(
          (await original.execute(sql`select body from public.notes`))[0]!.body,
        ).toBe("preserved booking");
        await original.execute(
          sql`set role ${sql.identifier(credentials.migrator.user)}`,
        );
        await original.execute(
          sql`create table public.__drizzle_migrations(id serial primary key, hash text not null, created_at bigint)`,
        );
        await original.execute(
          sql`insert into public.__drizzle_migrations(hash,created_at) values ('saved-history',1)`,
        );
        await original.execute(sql`reset role`);
        const savedHistory = await inspectAppDatabaseSchema(original);
        await original.execute(
          sql`update public.__drizzle_migrations set hash='different-history'`,
        );
        expect(await inspectAppDatabaseSchema(original)).not.toBe(savedHistory);
        await original.execute(
          sql`update public.__drizzle_migrations set hash='saved-history'`,
        );
        expect(await inspectAppDatabaseSchema(original)).toBe(savedHistory);
        expect(
          (await original.execute(sql`select body from public.notes`))[0]!.body,
        ).toBe("preserved booking");
      } finally {
        await projectClient.end({ timeout: 1 });
      }
    } finally {
      for (const socket of opened)
        await cleanupScopedDatabaseSocket(scope, socket.id);
      if (temporaryStarted)
        await cleanupDisposableDatabase(
          temporaryScope,
          temporaryId,
          scope.resourceId,
        );
    }
  },
  120_000,
);

acceptance(
  "publishing guardian and HTTP relay perform real CRUD through a private TLS broker",
  async () => {
    const signal = AbortSignal.timeout(90000),
      deploymentId = crypto.randomUUID();
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      signal,
    );
    const base = {
      version: 1 as const,
      nonce: crypto.randomUUID(),
      expectedDockerId: host.dockerId,
      deploymentId,
      projectId: scope.projectId,
      resourceId: scope.resourceId,
      claimToken: crypto.randomUUID(),
      confirmDurableIntent: true as const,
    };
    const httpVolume = `wrenly-deployment-http-${deploymentId}`,
      dbVolume = `wrenly-deployment-db-${deploymentId}`,
      brokerNetwork = `wrenly-deployment-network-${deploymentId}`,
      ingressNetwork = `wrenly-http-fixture-${deploymentId}`;
    const imageTag = `wrenly-crud-fixture:${deploymentId}`,
      brokerName = `wrenly-deployment-broker-${deploymentId}`;
    const fixture = await mkdtemp(join(tmpdir(), "wrenly-publishing-crud-"));
    let appId: string | undefined, relayId: string | undefined;
    const labels = (role: string): string[] =>
      Object.entries({
        "io.wrenly.deployment-id": deploymentId,
        "io.wrenly.project-id": scope.projectId,
        "io.wrenly.database-id": scope.resourceId,
        "io.wrenly.database-environment": "production",
        "io.wrenly.role": role,
      }).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
    try {
      await command([
        "bun",
        "build",
        join(
          import.meta.dir,
          "../src/deployment-runtime/application-entry.mts",
        ),
        "--target=bun",
        "--env=disable",
        `--outfile=${join(fixture, "guardian.js")}`,
      ]);
      await Bun.write(
        join(fixture, "app.ts"),
        `import postgres from ${JSON.stringify(join(import.meta.dir, "../../db/src/application-databases/driver.ts"))};
import { drizzle } from ${JSON.stringify(fileURLToPath(import.meta.resolve("drizzle-orm/postgres-js")))};
import { sql } from ${JSON.stringify(fileURLToPath(import.meta.resolve("drizzle-orm")))};
const client=postgres({max:1,connect_timeout:3,prepare:false}), database=drizzle(client);
if(process.getuid()!==1000)process.exit(1);
Bun.serve({hostname:"127.0.0.1",port:3000,async fetch(request){
 const path=new URL(request.url).pathname;
 try {
 if(path==="/create"){ await database.execute(sql\`insert into public.notes(body) values ('publishing CRUD fixture')\`); return new Response("saved"); }
 if(path==="/update"){ await database.execute(sql\`update public.notes set body='publishing CRUD updated' where body='publishing CRUD fixture'\`); return new Response("updated"); }
 if(path==="/read"){const rows=await database.execute(sql\`select body from public.notes where body like 'publishing CRUD%'\`);return Response.json(rows);}
 if(path==="/delete"){await database.execute(sql\`delete from public.notes where body like 'publishing CRUD%'\`);return new Response("deleted");}
 return new Response("ready");
 }catch{return new Response("database request failed",{status:500});}
}});`,
      );
      await command([
        "bun",
        "build",
        join(fixture, "app.ts"),
        "--target=bun",
        "--env=disable",
        `--outfile=${join(fixture, "next.js")}`,
      ]);
      await Bun.write(
        join(fixture, "Dockerfile"),
        'FROM oven/bun:alpine\nUSER 0:0\nWORKDIR /app\nCOPY guardian.js /wrenly/production-application.js\nCOPY next.js /app/node_modules/next/dist/bin/next\nLABEL io.wrenly.database-runtime-version="1"\nENTRYPOINT ["bun","--no-env-file","/wrenly/production-application.js"]\nCMD []\n',
      );
      await command(["docker", "build", "-t", imageTag, fixture]);
      const appImage = await docker.getImage(imageTag).inspect(),
        brokerImage = await docker
          .getImage("wrenly/database-socket:2")
          .inspect();
      await executeRuntimeVolumeRequest(
        { ...base, action: "create-http-volume" },
        host.dockerId,
        signal,
      );
      await executeRuntimeVolumeRequest(
        { ...base, action: "create-database-volume" },
        host.dockerId,
        signal,
      );
      const network = await executeRuntimeNetworkRequest(
        { ...base, action: "create-runtime-network" },
        host.dockerId,
        signal,
      );
      const upstream = {
        hostname: "production.internal.test",
        address: publishingAddress,
        port: publishingPort,
      };
      const resolver = async () => [{ address: publishingAddress, family: 4 }];
      const broker = await createRuntimeDatabaseBroker(
        {
          ...base,
          action: "create-runtime-broker",
          imageId: brokerImage.Id,
          networkId: network.network!.id,
          upstream,
          addresses: [publishingAddress],
          runtimeRole: credentials.runtime,
          certificateAuthority: authority,
        },
        host.dockerId,
        signal,
        resolver,
      );
      appId = await command([
        "docker",
        "create",
        "--network",
        "none",
        "--read-only",
        "--interactive",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--pids-limit",
        "256",
        "--cap-drop",
        "ALL",
        "--cap-add",
        "SETUID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "CHOWN",
        "--security-opt",
        "no-new-privileges:true",
        "--restart",
        "no",
        "--tmpfs",
        "/run/wrenly-bootstrap:rw,noexec,nosuid,nodev,size=1m,uid=0,gid=0,mode=0700",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000",
        ...labels("production-application"),
        "--mount",
        `type=volume,src=${httpVolume},dst=/run/wrenly-http`,
        "--mount",
        `type=volume,src=${dbVolume},dst=/run/wrenly-database,readonly`,
        imageTag,
      ]);
      await startRuntimeApplication(
        {
          ...base,
          action: "start-runtime-application",
          containerId: appId,
          imageId: appImage.Id,
          framework: "nextjs",
          runtimeRole: credentials.runtime,
          appKey: null,
          brokerId: broker.containerId,
          brokerImageId: brokerImage.Id,
          networkId: network.network!.id,
          upstream,
          addresses: [publishingAddress],
        },
        host.dockerId,
        signal,
        resolver,
      );
      await command(["docker", "network", "create", ingressNetwork]);
      relayId = await command([
        "docker",
        "run",
        "-d",
        "--network",
        ingressNetwork,
        "--user",
        "1000:1000",
        "--read-only",
        "--memory",
        "128m",
        "--cpus",
        "1",
        "--pids-limit",
        "64",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--restart",
        "no",
        "-p",
        "127.0.0.1::3000",
        ...labels("production-ingress"),
        "--mount",
        `type=volume,src=${httpVolume},dst=/run/wrenly-http,readonly`,
        "wrenly/deployment-ingress:1",
      ]);
      const relayImage = await docker
        .getImage("wrenly/deployment-ingress:1")
        .inspect();
      expect(
        (
          await findRuntimeIngress(
            { ...base, action: "find-runtime-ingress", imageId: relayImage.Id },
            host.dockerId,
            signal,
          )
        ).running,
      ).toBe(true);
      const info = await docker.getContainer(relayId).inspect(),
        port = info.NetworkSettings.Ports["3000/tcp"]![0]!.HostPort;
      const request = async (path: string): Promise<string> => {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          signal,
        });
        expect(response.status).toBe(200);
        return response.text();
      };
      expect(await request("/create")).toBe("saved");
      expect(await request("/read")).toContain("publishing CRUD fixture");
      expect(await request("/update")).toBe("updated");
      expect(await request("/read")).toContain("publishing CRUD updated");
      // A bare restart receives no saved password. This explicit new test intent
      // re-verifies the same app/broker before handing settings to its fresh PID1.
      await command(["docker", "restart", "--time", "1", appId]);
      await startRuntimeApplication(
        {
          ...base,
          nonce: crypto.randomUUID(),
          action: "start-runtime-application",
          containerId: appId,
          imageId: appImage.Id,
          framework: "nextjs",
          runtimeRole: credentials.runtime,
          appKey: null,
          brokerId: broker.containerId,
          brokerImageId: brokerImage.Id,
          networkId: network.network!.id,
          upstream,
          addresses: [publishingAddress],
        },
        host.dockerId,
        signal,
        resolver,
      );
      expect(await request("/read")).toContain("publishing CRUD updated");
      expect(await request("/delete")).toBe("deleted");
      expect(await request("/read")).toBe("[]");
      const appInspection = await docker.getContainer(appId).inspect();
      expect(appInspection.HostConfig.NetworkMode).toBe("none");
      expect(JSON.stringify(appInspection)).not.toContain(
        credentials.runtime.password,
      );
      expect(
        info.Mounts.every(
          (mount) => mount.Destination !== "/run/wrenly-database",
        ),
      ).toBe(true);
    } finally {
      for (const id of [relayId, appId, brokerName])
        if (id)
          await docker
            .getContainer(id)
            .remove({ force: true })
            .catch(() => {});
      for (const name of [httpVolume, dbVolume])
        await docker
          .getVolume(name)
          .remove()
          .catch(() => {});
      for (const name of [brokerNetwork, ingressNetwork])
        await docker
          .getNetwork(name)
          .remove()
          .catch(() => {});
      await docker
        .getImage(imageTag)
        .remove()
        .catch(() => {});
      await rm(fixture, { recursive: true, force: true });
    }
  },
  90000,
);
