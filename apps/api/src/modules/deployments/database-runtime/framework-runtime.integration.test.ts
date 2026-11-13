import { restartRuntimeDatabaseBroker } from "../../databases/production-targets/deployment-hosts/broker-restart";
/** Explicit native acceptance with real frameworks and private TLS; never uses an installation's services. */
import { expect, test } from "bun:test";
import Docker from "dockerode";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareProductionDatabaseArtifact } from "@wrenly/sandbox/runtime-artifact";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { laravelFixture } from "../../../../../../packages/sandbox/tests/laravel-fixture";
import { inspectRuntimeHost } from "../../databases/production-targets/deployment-hosts/helper";
import { executeRuntimeVolumeRequest } from "../../databases/production-targets/deployment-hosts/volumes";
import { executeRuntimeNetworkRequest } from "../../databases/production-targets/deployment-hosts/network";
import { createRuntimeDatabaseBroker } from "../../databases/production-targets/deployment-hosts/broker";
import { startRuntimeApplication } from "../../databases/production-targets/deployment-hosts/application-start";
const native =
  process.env.WRENLY_TEST_PRODUCTION_FRAMEWORK_RUNTIME === "true"
    ? test
    : test.skip;
const DEADLINE_MS = 600_000;
const PASSWORD = "c".repeat(64);
async function command(args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(args, {
    stdin: input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(input);
    child.stdin.end();
  }
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0)
    throw new Error(
      `Disposable framework fixture command failed: ${error.slice(-1500)}`,
    );
  return output.trim();
}
const dockerCommand = (args: string[], input?: string): Promise<string> =>
  command(["docker", "--host", "unix:///var/run/docker.sock", ...args], input);
function source(
  framework: "nextjs" | "laravel",
): Array<{ path: string; content: string }> {
  if (framework === "laravel") {
    const files = laravelFixture().filter(
      (file) => file.path !== "routes/web.php",
    );
    files.push({
      path: "routes/web.php",
      content: `<?php
use Illuminate\\Support\\Facades\\Route;
use Illuminate\\Support\\Facades\\DB;
Route::get('/', fn () => response('Production Laravel fixture'));
Route::get('/probe', function () {
  $mode=request('mode'); $value=request('value');
  if ($mode === 'create') DB::table('notes')->insert(['id'=>1,'name'=>$value]);
  if ($mode === 'update') DB::table('notes')->where('id',1)->update(['name'=>$value]);
  return response()->json(DB::table('notes')->where('id',1)->first());
});`,
    });
    files.push({
      path: "wrenly.app.json",
      content: JSON.stringify({
        version: 1,
        database: {
          engine: "postgresql",
          adapter: "laravel",
          migrations: [
            "database/migrations/2026_01_01_000000_create_notes_table.php",
          ],
        },
      }),
    });
    files.push({
      path: "database/migrations/2026_01_01_000000_create_notes_table.php",
      content:
        "<?php\nuse Illuminate\\Database\\Migrations\\Migration;\nuse Illuminate\\Database\\Schema\\Blueprint;\nuse Illuminate\\Support\\Facades\\Schema;\nreturn new class extends Migration { public function up(): void { Schema::create('notes', function(Blueprint $table) { $table->integer('id')->primary(); $table->text('name'); }); } public function down(): void { Schema::dropIfExists('notes'); } };",
    });
    return files;
  }
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "production-crud-fixture",
        scripts: { build: "next build" },
        dependencies: {
          next: "15.5.28",
          react: "19.3.1",
          "react-dom": "19.3.1",
          postgres: "3.4.9",
          "drizzle-orm": "0.45.3",
        },
      }),
    },
    {
      path: "next.config.mjs",
      content: "export default {experimental:{cpus:1}}",
    },
    {
      path: "app/layout.jsx",
      content:
        "export default function Layout({children}) {return <html><body>{children}</body></html>}",
    },
    {
      path: "app/page.jsx",
      content:
        "export const dynamic='force-dynamic'; export default function Page(){return <main>Production Next.js fixture</main>}",
    },
    {
      path: "app/probe/route.js",
      content: `import postgres from 'postgres'; import {drizzle} from 'drizzle-orm/postgres-js'; import {pgTable,integer,text} from 'drizzle-orm/pg-core'; import {eq} from 'drizzle-orm';
export const dynamic='force-dynamic'; const notes=pgTable('notes',{id:integer('id').primaryKey(),name:text('name').notNull()}); const db=drizzle(postgres({max:1}));
export async function GET(request){const q=new URL(request.url).searchParams; if(q.get('mode')==='create')await db.insert(notes).values({id:1,name:q.get('value')}); if(q.get('mode')==='update')await db.update(notes).set({name:q.get('value')}).where(eq(notes.id,1)); return Response.json((await db.select().from(notes).where(eq(notes.id,1)))[0]);}`,
    },
    {
      path: "wrenly.app.json",
      content: JSON.stringify({
        version: 1,
        database: {
          engine: "postgresql",
          adapter: "drizzle-postgres",
          migrations: ["drizzle/0000_notes.sql"],
        },
      }),
    },
    {
      path: "drizzle/0000_notes.sql",
      content:
        "CREATE TABLE notes(id integer PRIMARY KEY, name text NOT NULL);",
    },
    {
      path: "drizzle/meta/_journal.json",
      content: JSON.stringify({
        dialect: "postgresql",
        entries: [{ idx: 0, tag: "0000_notes", when: 1, breakpoints: true }],
      }),
    },
  ];
}
for (const framework of ["nextjs", "laravel"] as const)
  native(
    `${framework} persists real records across an explicitly verified Production app restart`,
    async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "wrenly-framework-runtime-"),
      );
      const scope = crypto.randomUUID();
      const serverName = `wrenly-framework-pg-${scope}`;
      const fixtureNetwork = `wrenly-framework-tls-${scope}`;
      const deploymentId = crypto.randomUUID(),
        resourceId = crypto.randomUUID(),
        projectId = crypto.randomUUID();
      const database = `wrenly_${resourceId.replaceAll("-", "")}`,
        role = `${database}_runtime`;
      const httpVolume = `wrenly-deployment-http-${deploymentId}`,
        dbVolume = `wrenly-deployment-db-${deploymentId}`,
        runtimeNetwork = `wrenly-deployment-network-${deploymentId}`;
      const docker = new Docker({ socketPath: "/var/run/docker.sock" });
      let imageId: string | undefined;
      let appId: string | undefined;
      const signal = AbortSignal.timeout(DEADLINE_MS);
      try {
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
          "/CN=apps.internal.test",
          "-addext",
          "subjectAltName=DNS:apps.internal.test",
        ]);
        await dockerCommand(["network", "create", fixtureNetwork]);
        const networkInfo = JSON.parse(
          await dockerCommand(["network", "inspect", fixtureNetwork]),
        ) as Array<{ IPAM: { Config: Array<{ Gateway: string }> } }>;
        const address = networkInfo[0]!.IPAM.Config[0]!.Gateway;
        await dockerCommand([
          "run",
          "-d",
          "--name",
          serverName,
          "--network",
          fixtureNetwork,
          "-p",
          `${address}::5432`,
          "-e",
          "POSTGRES_PASSWORD=fixture-management-secret",
          "-v",
          `${directory}:/fixture:ro`,
          "--entrypoint",
          "sh",
          "postgres:17-alpine",
          "-c",
          "cp /fixture/server.key /tmp/server.key && cp /fixture/server.crt /tmp/server.crt && chmod 600 /tmp/server.key && chown postgres:postgres /tmp/server.key /tmp/server.crt && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/tmp/server.crt -c ssl_key_file=/tmp/server.key",
        ]);
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            await dockerCommand([
              "exec",
              serverName,
              "pg_isready",
              "-h",
              "127.0.0.1",
              "-U",
              "postgres",
            ]);
            ready = true;
            break;
          } catch {
            await Bun.sleep(100);
          }
        }
        if (!ready) throw new Error("Disposable PostgreSQL did not start");
        await dockerCommand([
          "exec",
          serverName,
          "psql",
          "-U",
          "postgres",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `CREATE ROLE ${role} LOGIN PASSWORD '${PASSWORD}';`,
        ]);
        await dockerCommand([
          "exec",
          serverName,
          "createdb",
          "-U",
          "postgres",
          database,
        ]);
        await dockerCommand([
          "exec",
          serverName,
          "psql",
          "-U",
          "postgres",
          "-d",
          database,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `CREATE TABLE notes(id integer PRIMARY KEY,name text NOT NULL); REVOKE ALL ON DATABASE ${database} FROM PUBLIC; REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT CONNECT ON DATABASE ${database} TO ${role}; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT,INSERT,UPDATE ON notes TO ${role};`,
        ]);
        const server = await docker.getContainer(serverName).inspect();
        const port = Number(
          server.NetworkSettings.Ports["5432/tcp"]?.[0]?.HostPort,
        );
        const output = join(directory, "guardian.js");
        await command([
          "bun",
          "--no-env-file",
          "build",
          join(
            import.meta.dir,
            "../../../../../../packages/sandbox/src/deployment-runtime/application-entry.mts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${output}`,
        ]);
        const files = source(framework),
          manifest = readAppDatabaseManifest(files, framework);
        if (!manifest) throw new Error("Fixture manifest missing");
        const artifact = await prepareProductionDatabaseArtifact({
          deploymentId,
          stack: framework,
          files,
          migrationDigest: manifest.digest,
          bootstrap: await readFile(output),
          signal,
          beforeEffect: async () => {},
        });
        imageId = artifact.imageId;
        const host = await inspectRuntimeHost(
          { version: 1, action: "inspect", nonce: crypto.randomUUID() },
          signal,
        );
        const base = {
          version: 1 as const,
          nonce: crypto.randomUUID(),
          expectedDockerId: host.dockerId,
          deploymentId,
          projectId,
          resourceId,
          claimToken: crypto.randomUUID(),
          confirmDurableIntent: true as const,
        };
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
        const brokerNetwork = await executeRuntimeNetworkRequest(
          { ...base, action: "create-runtime-network" },
          host.dockerId,
          signal,
        );
        const brokerImage = await docker
          .getImage("wrenly/database-socket:2")
          .inspect();
        const upstream = { hostname: "apps.internal.test", address, port };
        const resolver = async () => [{ address, family: 4 }];
        const broker = await createRuntimeDatabaseBroker(
          {
            ...base,
            action: "create-runtime-broker",
            imageId: brokerImage.Id,
            networkId: brokerNetwork.network!.id,
            upstream,
            addresses: [address],
            runtimeRole: { user: role, password: PASSWORD },
            certificateAuthority: await readFile(
              join(directory, "server.crt"),
              "utf8",
            ),
          },
          host.dockerId,
          signal,
          resolver,
        );
        const labels = {
          "io.wrenly.deployment-id": deploymentId,
          "io.wrenly.project-id": projectId,
          "io.wrenly.database-id": resourceId,
          "io.wrenly.database-environment": "production",
          "io.wrenly.role": "production-application",
        };
        appId = await dockerCommand([
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
          "/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
          ...Object.entries(labels).flatMap(([key, value]) => [
            "--label",
            `${key}=${value}`,
          ]),
          "--mount",
          `type=volume,src=${httpVolume},dst=/run/wrenly-http`,
          "--mount",
          `type=volume,src=${dbVolume},dst=/run/wrenly-database,readonly`,
          ...(framework === "laravel"
            ? [
                "--tmpfs",
                "/app/storage:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
                "--tmpfs",
                "/app/bootstrap/cache:rw,noexec,nosuid,size=16m,uid=1000,gid=1000",
              ]
            : []),
          imageId,
        ]);
        const startup = {
          ...base,
          action: "start-runtime-application",
          containerId: appId,
          imageId,
          framework,
          runtimeRole: { user: role, password: PASSWORD },
          appKey:
            framework === "laravel"
              ? "base64:" + Buffer.alloc(32, 1).toString("base64")
              : null,
          brokerId: broker.containerId,
          brokerImageId: brokerImage.Id,
          networkId: brokerNetwork.network!.id,
          upstream,
          addresses: [address],
        };
        expect(
          (
            await startRuntimeApplication(
              startup,
              host.dockerId,
              signal,
              resolver,
            )
          ).running,
        ).toBe(true);
        async function probe(
          query: string,
        ): Promise<{ id: number; name: string }> {
          const code = `const response=await fetch('http://localhost/probe?'+process.argv[1],{unix:'/run/wrenly-http/http.sock'});if(!response.ok)process.exit(1);process.stdout.write(await response.text());`;
          return JSON.parse(
            await dockerCommand([
              "run",
              "--rm",
              "--network",
              "none",
              "--user",
              "1000:1000",
              "--read-only",
              "--mount",
              `type=volume,src=${httpVolume},dst=/run/wrenly-http,readonly`,
              "oven/bun:alpine",
              "bun",
              "--no-env-file",
              "-e",
              code,
              query,
            ]),
          ) as { id: number; name: string };
        }
        expect((await probe("mode=create&value=before-restart")).name).toBe(
          "before-restart",
        );
        expect((await probe("mode=update&value=after-update")).name).toBe(
          "after-update",
        );
        const inspection = await dockerCommand(["inspect", appId]);
        expect(inspection).not.toContain(PASSWORD);
        expect(JSON.parse(inspection)[0].HostConfig.NetworkMode).toBe("none");
        await expect(
          startRuntimeApplication(startup, host.dockerId, signal, resolver),
        ).rejects.toThrow();
        await dockerCommand(["stop", appId]);
        await dockerCommand(["stop", broker.containerId]);
        const restartedBroker = await restartRuntimeDatabaseBroker(
          {
            ...base,
            action: "restart-runtime-broker",
            nonce: crypto.randomUUID(),
            claimToken: crypto.randomUUID(),
            containerId: broker.containerId,
            imageId: brokerImage.Id,
            networkId: brokerNetwork.network!.id,
            upstream,
            addresses: [address],
            runtimeRole: { user: role, password: PASSWORD },
            certificateAuthority: await readFile(
              join(directory, "server.crt"),
              "utf8",
            ),
          },
          host.dockerId,
          signal,
          resolver,
        );
        expect(restartedBroker.containerId).toBe(broker.containerId);
        expect(restartedBroker.socketReady).toBe(true);
        expect(
          await dockerCommand(["inspect", broker.containerId]),
        ).not.toContain(PASSWORD);

        expect(
          (
            await startRuntimeApplication(
              {
                ...startup,
                nonce: crypto.randomUUID(),
                claimToken: crypto.randomUUID(),
              },
              host.dockerId,
              signal,
              resolver,
            )
          ).running,
        ).toBe(true);
        expect((await probe("mode=read")).name).toBe("after-update");
      } finally {
        for (const name of [
          appId,
          `wrenly-deployment-broker-${deploymentId}`,
          serverName,
        ])
          if (name)
            await dockerCommand(["rm", "--force", "--volumes", name]).catch(
              () => {},
            );
        for (const name of [httpVolume, dbVolume])
          await dockerCommand(["volume", "rm", name]).catch(() => {});
        for (const name of [runtimeNetwork, fixtureNetwork])
          await dockerCommand(["network", "rm", name]).catch(() => {});
        if (imageId)
          await docker
            .getImage(imageId)
            .remove({ force: true })
            .catch(() => {});
        await rm(directory, { recursive: true, force: true });
      }
    },
    DEADLINE_MS,
  );
