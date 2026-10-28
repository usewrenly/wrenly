import { verifyPreparedPreview } from "./helpers/prepared-preview-acceptance";
import { runLaravelDatabaseMigrations } from "../src/databases/laravel-migrations";
import { prepareDatabaseValidationArtifact } from "../src/artifacts/runtime-artifact";
import { applicationDatabaseEnvironment } from "../src/databases/application-runtime/environment";
import { DATABASE_APPLICATION_READY } from "../src/databases/application-runtime/bootstrap";
import { checkDisposableApplicationHttp } from "../src/databases/application-runtime/runner";
import { validateFreshDatabaseApplication } from "../../../apps/api/src/modules/databases/database-application-validation";
import { laravelFixture } from "./laravel-fixture";
import { runDatabaseSocketWorker } from "../src/databases/database-socket-worker";
import { rehearseDatabaseMigrations } from "../../../apps/api/src/modules/databases/database-migration-rehearsal";
import { readAppDatabaseManifest } from "../src/databases/database-manifest";
import {
  captureManagedDatabaseBackup,
  restoreDisposableDatabaseBackup,
} from "../src/databases/database-backup-runtime";
import {
  sealDatabaseBackup,
  openDatabaseBackup,
} from "../../../apps/api/src/modules/databases/database-backup-storage";
// Creates only UUID-scoped disposable database resources, never operator databases.
import { describe, expect, test } from "bun:test";
import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import {
  enforceManagedDatabaseRolePolicy,
  terminateManagedDatabaseSessions,
  inspectManagedDatabaseSchema,
  provisionManagedDatabaseRoles,
} from "../src/databases/database-administrator";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  startDatabaseSocket,
  cleanupDatabaseSocket,
  type DatabaseSocketIdentity,
} from "../src/databases/database-socket";
import {
  createManagedDatabase,
  inspectManagedDatabase,
  setManagedDatabaseRunning,
  type DatabaseRuntimeEffect,
  type DatabaseRuntimeFence,
} from "../src/databases/database-runtime";
import {
  managedDatabaseNames,
  type ManagedDatabaseScope,
} from "../src/databases/database-resource-policy";
const integration =
  process.env.WRENLY_TEST_APP_DATABASE_RUNTIME === "true"
    ? describe
    : describe.skip;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
function fixture(): {
  scope: ManagedDatabaseScope;
  administrator: { user: string; password: string };
  operationId: string;
} {
  const scope: ManagedDatabaseScope = {
    resourceId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    environment: "development",
  };
  return {
    scope,
    administrator: {
      user: `wrenly_${scope.resourceId.replaceAll("-", "")}_admin`,
      password: randomBytes(32).toString("hex"),
    },
    operationId: crypto.randomUUID(),
  };
}
function fence(events: string[]): DatabaseRuntimeFence {
  let pending: DatabaseRuntimeEffect | undefined;
  return {
    assertHeld: async () => {},
    beforeEffect: async (entry) => {
      if (pending) throw new Error("Unresolved effect");
      pending = entry;
      events.push(`before:${entry.kind}`);
    },
    acknowledgeEffect: async (entry) => {
      expect(entry).toEqual(pending);
      events.push(`after:${entry.kind}`);
      pending = undefined;
    },
  };
}
async function cleanup(scope: ManagedDatabaseScope): Promise<void> {
  const filter = {
    label: [
      `io.wrenly.database-id=${scope.resourceId}`,
      `io.wrenly.project-id=${scope.projectId}`,
    ],
  };
  for (const item of await docker.listContainers({
    all: true,
    filters: JSON.stringify(filter),
  }))
    await docker.getContainer(item.Id).remove({ force: true, v: true });
  for (const volume of (
    await docker.listVolumes({ filters: JSON.stringify(filter) })
  ).Volumes ?? []) {
    if (
      ["database-data", "database-socket"].includes(
        volume.Labels?.["io.wrenly.role"] ?? "",
      )
    )
      await docker.getVolume(volume.Name).remove();
  }
  const names = managedDatabaseNames(scope);
  try {
    const volume = await docker.getVolume(names.volume).inspect();
    if (volume.Labels?.["io.wrenly.database-id"] === scope.resourceId)
      await docker.getVolume(names.volume).remove();
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
    const network = await docker.getNetwork(names.network).inspect();
    if (network.Labels?.["io.wrenly.database-id"] === scope.resourceId)
      await docker.getNetwork(network.Id).remove();
  } catch (error) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 404
    ))
      throw error;
  }
}
async function query(
  containerId: string,
  administrator: { user: string; password: string },
  sql: string,
): Promise<string> {
  const child = Bun.spawn(
    [
      "docker",
      "--host",
      "unix:///var/run/docker.sock",
      "exec",
      "-i",
      containerId,
      "sh",
      "-ec",
      'IFS= read -r PGPASSWORD; test "${#PGPASSWORD}" -eq 64; export PGPASSWORD; exec psql -h /tmp -U "$1" -d app -v ON_ERROR_STOP=1 -At',
      "sh",
      administrator.user,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  child.stdin.write(administrator.password + "\n" + sql + "\n");
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`Fixture query failed: ${stderr}`);
    return stdout;
  } finally {
    clearTimeout(timer);
  }
}

integration("managed PostgreSQL runtime", () => {
  test("trusted Laravel watchdog bounds generated PHP after its caller disappears", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-migration-watchdog-test-"));
    const name = `wrenly-migration-watchdog-test-${crypto.randomUUID()}`;
    try {
      await writeFile(join(directory, "migrate.php"), `<?php
        passthru('id -u');
        // Unprivileged generated code must not be able to kill the root guardian.
        shell_exec('kill -KILL 1 2>/dev/null');
        while (true) { sleep(1); }
      `, { mode: 0o644 });
      const started = Date.now();
      const child = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", "run", "--rm",
        "--name", name, "--network=none", "--read-only", "--user=0:0",
        "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID",
        "--security-opt=no-new-privileges:true", "--memory=128m", "--cpus=0.5", "--pids-limit=32",
        "--log-driver=none", "--mount", `type=bind,source=${join(directory, "migrate.php")},target=/wrenly/migrate.php,readonly`,
        "--entrypoint=bun", "wrenly/laravel-runtime:13-php8.4", "--no-env-file", "/wrenly/migration-watchdog.ts"],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      expect(await new Response(child.stdout).text()).toBe("1000\n");
      expect(await child.exited).toBe(137);
      expect(Date.now() - started).toBeGreaterThanOrEqual(60_000);
      expect(await docker.listContainers({ all: true, filters: JSON.stringify({ name: [name] }) })).toHaveLength(0);
    } finally {
      await docker.getContainer(name).remove({ force: true, v: true }).catch((error: unknown) => {
        if (!(typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404)) throw error;
      });
      await rm(directory, { recursive: true, force: true });
    }
  }, 80_000);
  test("fresh Laravel validation prepares its image before creating a disposable database", async () => {
    const operationId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const sourceResourceId = crypto.randomUUID();
    const deadline = Date.now() + 300_000;
    const signal = AbortSignal.timeout(300_000);
    const migrationPath = "database/migrations/2026_10_23_000000_create_reservations.php";
    const files = [...laravelFixture(), { path: migrationPath, content: `<?php
      use Illuminate\\Database\\Migrations\\Migration;
      use Illuminate\\Database\\Schema\\Blueprint;
      use Illuminate\\Support\\Facades\\Schema;
      return new class extends Migration {
        public function up(): void { Schema::create('reservations', function (Blueprint $table) {
          $table->id(); $table->string('name');
        }); }
      };` }, { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
        engine: "postgresql", adapter: "laravel", migrations: [migrationPath],
      } }) }];
    let imageId: string | undefined;
    let preparationChecks = 0;
    try {
      const artifact = await prepareDatabaseValidationArtifact({ deploymentId: operationId, stack: "laravel", migrationDigest: readAppDatabaseManifest(files, "laravel")!.digest, files, signal,
        beforeEffect: async () => {
          signal.throwIfAborted();
          expect(await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`io.wrenly.database-id=${operationId}`] }) })).toHaveLength(0);
          preparationChecks++;
        } });
      imageId = artifact.imageId;
      expect(preparationChecks).toBeGreaterThan(0);
      const digest = readAppDatabaseManifest(files, "laravel")!.digest;
      const cleanupEvents: string[] = [];
      const result = await validateFreshDatabaseApplication({ framework: "laravel", projectId,
        sourceResourceId, operationId, files, migrationDigest: digest, imageId,
        remainingMs: deadline - Date.now(), fence: fence([]), signal,
        cleanup: { assertHeld: async () => {},
          beforeCleanup: async (kind, id) => { cleanupEvents.push(`before:${kind}:${id}`); },
          acknowledgeCleanup: async (kind, id) => { cleanupEvents.push(`after:${kind}:${id}`); } } });
      expect(result).toMatchObject({ migrationDigest: digest, httpReady: true });
      expect(result.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(cleanupEvents.filter(event => event.startsWith("after:"))).toHaveLength(4);
      await expect(docker.getContainer(`wrenly-database-${operationId}`).inspect()).rejects.toMatchObject({ statusCode: 404 });
      await expect(docker.getVolume(`wrenly-database-${operationId}-data`).inspect()).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanup({ resourceId: operationId, projectId, environment: "development" });
      if (imageId) await docker.getImage(imageId).remove({ force: false });
    }
  }, 310_000);

  test("native Laravel migrations use a scoped offline socket and preserve their journal", async () => {
    const input = fixture();
    const directory = await mkdtemp(join(tmpdir(), "wrenly-laravel-database-test-"));
    const signal = AbortSignal.timeout(300_000);
    const ownership = fence([]);
    const role = (suffix: string): { user: string; password: string } => ({
      user: `wrenly_${input.scope.resourceId.replaceAll("-", "")}_${suffix}`,
      password: randomBytes(32).toString("hex"),
    });
    const credentials = { version: 1, database: "app", administrator: input.administrator,
      migrator: role("migrate"), runtime: role("runtime"), reader: role("reader") };
    let socket: DatabaseSocketIdentity | undefined;
    try {
      const bundlePath = join(directory, "administrator.js");
      const build = Bun.spawn([process.execPath, "--no-env-file", "build",
        resolve(import.meta.dir, "../../../apps/api/src/modules/databases/database-administrator-worker.ts"),
        "--target=bun", "--env=disable", `--outfile=${bundlePath}`], { stdout: "ignore", stderr: "ignore" });
      if (await build.exited !== 0) throw new Error("Trusted administrator bundle failed");
      const journalPath = join(directory, "journal.js");
      const journalBuild = Bun.spawn([process.execPath, "--no-env-file", "build",
        resolve(import.meta.dir, "../../../apps/api/src/modules/databases/database-migration-worker.ts"),
        "--target=bun", "--env=disable", `--outfile=${journalPath}`], { stdout: "ignore", stderr: "ignore" });
      if (await journalBuild.exited !== 0) throw new Error("Trusted journal bundle failed");
      const journalBundle = await readFile(journalPath);
      const database = await createManagedDatabase({ ...input, fence: ownership, signal });
      const administrator = { scope: input.scope, database, operationId: crypto.randomUUID(),
        credentials, administratorBundle: await readFile(bundlePath), fence: ownership, signal };
      await provisionManagedDatabaseRoles(administrator);
      socket = await startDatabaseSocket({ scope: input.scope, database, socketId: crypto.randomUUID(),
        role: { kind: "migrator", ...credentials.migrator }, fence: ownership, signal });
      const path = "database/migrations/2026_10_23_000000_create_reservations.php";
      const files = [...laravelFixture(),
        { path, content: `<?php
          use Illuminate\\Database\\Migrations\\Migration;
          use Illuminate\\Database\\Schema\\Blueprint;
          use Illuminate\\Support\\Facades\\Schema;
          return new class extends Migration {
            public function up(): void { Schema::create('reservations', function (Blueprint $table) {
              $table->id(); $table->string('name');
            }); }
          };` },
        { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
          engine: "postgresql", adapter: "laravel", migrations: [path],
        } }) },
      ];
      const migrationDigest = readAppDatabaseManifest(files, "laravel")!.digest;
      const beforeSchemaDigest = await inspectManagedDatabaseSchema(administrator);
      const archive = await captureManagedDatabaseBackup({ scope: input.scope, database,
        operationId: crypto.randomUUID(), role: credentials.migrator, fence: ownership, signal });
      const rehearsalId = crypto.randomUUID();
      const rehearsal = await rehearseDatabaseMigrations({
        projectId: input.scope.projectId, resourceId: input.scope.resourceId,
        operationId: rehearsalId, archive, backupSchemaDigest: beforeSchemaDigest,
        files, migrationDigest, framework: "laravel", administratorBundle: administrator.administratorBundle,
        migrationBundle: journalBundle, fence: ownership, signal,
      });
      expect(await inspectManagedDatabaseSchema(administrator)).toBe(beforeSchemaDigest);
      expect(await docker.listContainers({ all: true, filters: JSON.stringify({
        label: [`io.wrenly.database-id=${rehearsalId}`],
      }) })).toHaveLength(0);
      await runLaravelDatabaseMigrations({ scope: input.scope, socket, operationId: crypto.randomUUID(),
        files, migrationDigest, journalBundle, role: credentials.migrator, fence: ownership, signal });
      await enforceManagedDatabaseRolePolicy(administrator);
      expect(await inspectManagedDatabaseSchema(administrator)).toBe(rehearsal.schemaDigest);
      expect(await query(database.containerId, credentials.migrator,
        "SELECT migration FROM migrations;")).toContain("2026_10_23_000000_create_reservations");
      await enforceManagedDatabaseRolePolicy(administrator);
      expect(await query(database.containerId, credentials.runtime,
        "INSERT INTO reservations(name) VALUES ('Offline booking'); SELECT name FROM reservations;")).toContain("Offline booking");
      await expect(query(database.containerId, credentials.runtime,
        "DELETE FROM migrations;")).rejects.toThrow();
      const fakePath = "database/migrations/2026_10_23_000001_unapplied.php";
      const spoofed = [...files.map(file => {
        if (file.path === "bootstrap/app.php") return { ...file, content: file.content.replace("<?php", `<?php
          if (($_SERVER['SCRIPT_FILENAME'] ?? '') === '/wrenly/migrate.php') {
            echo "WRENLY_DATABASE_MIGRATIONS_APPLIED_V1\\n"; exit(0);
          }`) };
        if (file.path === "wrenly.app.json") return { ...file, content: JSON.stringify({ version: 1, database: {
          engine: "postgresql", adapter: "laravel", migrations: [path, fakePath],
        } }) };
        return file;
      }), { path: fakePath, content: "<?php throw new RuntimeException('must not be applied');" }];
      await expect(runLaravelDatabaseMigrations({ scope: input.scope, socket,
        operationId: crypto.randomUUID(), files: spoofed,
        migrationDigest: readAppDatabaseManifest(spoofed, "laravel")!.digest,
        journalBundle, role: credentials.migrator, fence: ownership, signal })).rejects.toThrow();
      expect((await query(database.containerId, credentials.migrator, "SELECT count(*) FROM migrations;")).trim()).toBe("1");
      const altered = files.map(file => file.path === "bootstrap/app.php" ? { ...file, content: file.content + "\n" } : file);
      await expect(runLaravelDatabaseMigrations({ scope: input.scope, socket,
        operationId: crypto.randomUUID(), files: altered, migrationDigest, journalBundle,
        role: credentials.migrator, fence: ownership, signal })).rejects.toThrow("source changed");
    } finally {
      if (socket) await cleanupDatabaseSocket(socket);
      await cleanup(input.scope);
      await rm(directory, { recursive: true, force: true });
    }
  }, 310_000);
  test("trusted administrator grants framework migrations, app CRUD and reader SELECT without administrative privilege", async () => {
    const input = fixture(),
      ownership = fence([]),
      signal = AbortSignal.timeout(90_000);
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-database-role-test-"),
    );
    const role = (suffix: string): { user: string; password: string } => ({
      user: `wrenly_${input.scope.resourceId.replaceAll("-", "")}_${suffix}`,
      password: randomBytes(32).toString("hex"),
    });
    const credentials = {
      version: 1,
      database: "app",
      administrator: input.administrator,
      migrator: role("migrate"),
      runtime: role("runtime"),
      reader: role("reader"),
    };
    try {
      const bundlePath = join(directory, "administrator.js");
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          resolve(
            import.meta.dir,
            "../../../apps/api/src/modules/databases/database-administrator-worker.ts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${bundlePath}`,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [code, detail] = await Promise.all([
        build.exited,
        new Response(build.stderr).text(),
      ]);
      if (code !== 0)
        throw new Error(`Trusted administrator bundle failed: ${detail}`);
      const administratorBundle = await readFile(bundlePath);
      expect(administratorBundle.toString()).not.toContain(
        "WRENLY_DATABASE_URL",
      );
      expect(administratorBundle.toString()).not.toContain(
        "WRENLY_AUTH_SECRET",
      );
      expect(administratorBundle.toString()).not.toContain(
        input.administrator.password,
      );
      const database = await createManagedDatabase({
        ...input,
        fence: ownership,
        signal,
      });
      await provisionManagedDatabaseRoles({
        scope: input.scope,
        database,
        operationId: crypto.randomUUID(),
        credentials,
        administratorBundle,
        fence: ownership,
        signal,
      });
      await query(
        database.containerId,
        credentials.migrator,
        "CREATE TABLE notes (id serial PRIMARY KEY, body text);",
      );
      expect(
        await query(
          database.containerId,
          credentials.runtime,
          "INSERT INTO notes (body) VALUES ('Runtime role'); SELECT body FROM notes;",
        ),
      ).toContain("Runtime role");
      expect(
        await query(
          database.containerId,
          credentials.reader,
          "SELECT body FROM notes;",
        ),
      ).toContain("Runtime role");
      for (const statement of [
        "CREATE TABLE forbidden (id int);",
        "ALTER TABLE notes ADD COLUMN forbidden int;",
        "DROP TABLE notes;",
        "CREATE ROLE forbidden;",
        `SET ROLE ${credentials.migrator.user};`,
      ])
        await expect(
          query(database.containerId, credentials.runtime, statement),
        ).rejects.toThrow("Fixture query failed");
      await expect(
        query(
          database.containerId,
          credentials.reader,
          "SET default_transaction_read_only=off; INSERT INTO notes (body) VALUES ('Forbidden');",
        ),
      ).rejects.toThrow("permission denied");
      await expect(
        query(database.containerId, credentials.reader, "SELECT pg_sleep(3);"),
      ).rejects.toThrow("statement timeout");
      await expect(
        query(
          database.containerId,
          credentials.migrator,
          "CREATE SCHEMA forbidden;",
        ),
      ).rejects.toThrow("permission denied");
      await expect(
        query(
          database.containerId,
          credentials.migrator,
          "CREATE ROLE forbidden;",
        ),
      ).rejects.toThrow("permission denied");
      await expect(
        query(
          database.containerId,
          credentials.migrator,
          "CREATE DATABASE forbidden;",
        ),
      ).rejects.toThrow("permission denied");
      expect(
        await query(
          database.containerId,
          credentials.runtime,
          "UPDATE notes SET body='Updated'; SELECT body FROM notes;",
        ),
      ).toContain("Updated");
      const flags = await query(
        database.containerId,
        credentials.administrator,
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname <> current_user AND rolname LIKE 'wrenly_%' ORDER BY rolname;",
      );
      expect(flags.trim().split("\n")).toEqual([
        "f|f|f|f|f",
        "f|f|f|f|f",
        "f|f|f|f|f",
      ]);
      await expect(
        provisionManagedDatabaseRoles({
          scope: input.scope,
          database,
          operationId: crypto.randomUUID(),
          credentials: { ...credentials, runtime: role("runtime") },
          administratorBundle,
          fence: fence([]),
          signal,
        }),
      ).rejects.toThrow("role provisioning");
      expect(
        await query(
          database.containerId,
          credentials.runtime,
          "SELECT count(*) FROM notes;",
        ),
      ).toContain("1");
      await query(
        database.containerId,
        credentials.runtime,
        "DELETE FROM notes;",
      );
      expect(
        await query(
          database.containerId,
          credentials.reader,
          "SELECT count(*) FROM notes;",
        ),
      ).toContain("0");
    } finally {
      await cleanup(input.scope);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
  test("custom archive is encrypted and restores real rows into a separate disposable database", async () => {
    const source = fixture(),
      target = fixture();
    target.scope.resourceId = target.operationId;
    target.administrator.user = `wrenly_${target.scope.resourceId.replaceAll("-", "")}_admin`;
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-database-backup-test-"),
    );
    const signal = AbortSignal.timeout(110_000);
    const credentials = (input: ReturnType<typeof fixture>) => {
      const role = (suffix: string) => ({
        user: `wrenly_${input.scope.resourceId.replaceAll("-", "")}_${suffix}`,
        password: randomBytes(32).toString("hex"),
      });
      return {
        version: 1,
        database: "app",
        administrator: input.administrator,
        migrator: role("migrate"),
        runtime: role("runtime"),
        reader: role("reader"),
      };
    };
    const sourceRoles = credentials(source),
      targetRoles = credentials(target);
    try {
      const bundlePath = join(directory, "administrator.js");
      const build = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          resolve(
            import.meta.dir,
            "../../../apps/api/src/modules/databases/database-administrator-worker.ts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${bundlePath}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await build.exited) !== 0)
        throw new Error("Trusted helper build failed");
      const bundle = await readFile(bundlePath);
      const sourceDatabase = await createManagedDatabase({
        ...source,
        fence: fence([]),
        signal,
      });
      await provisionManagedDatabaseRoles({
        scope: source.scope,
        database: sourceDatabase,
        operationId: crypto.randomUUID(),
        credentials: sourceRoles,
        administratorBundle: bundle,
        fence: fence([]),
        signal,
      });
      const migrationSource = [
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
            "CREATE TABLE notes (id serial PRIMARY KEY, body text);\n--> statement-breakpoint\nINSERT INTO notes (body) VALUES ('Verified private backup row');\n--> statement-breakpoint\nCREATE TABLE compound_notes (tenant integer, id integer, body text, PRIMARY KEY (tenant,id) INCLUDE (body));",
        },
        {
          path: "drizzle/meta/_journal.json",
          content: JSON.stringify({
            version: "7",
            dialect: "postgresql",
            entries: [
              {
                idx: 0,
                version: "7",
                when: 1,
                tag: "0000_notes",
                breakpoints: true,
              },
            ],
          }),
        },
      ];
      const migrationSet = readAppDatabaseManifest(migrationSource, "nextjs");
      if (!migrationSet) throw new Error("Missing frozen migration set");
      const migrationBundlePath = join(directory, "migrate.js");
      const migrationBuild = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          resolve(
            import.meta.dir,
            "../../../apps/api/src/modules/databases/database-migration-worker.ts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${migrationBundlePath}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await migrationBuild.exited) !== 0)
        throw new Error("Migration helper did not build");
      const migrationSocket = await startDatabaseSocket({
        scope: source.scope,
        database: sourceDatabase,
        socketId: crypto.randomUUID(),
        role: { kind: "migrator", ...sourceRoles.migrator },
        fence: fence([]),
        signal,
      });
      try {
        const runMigration = async (
          expectedSuccess = true,
        ): Promise<number> => {
          try {
            await runDatabaseSocketWorker({
              kind: "migration",
              scope: source.scope,
              socket: migrationSocket,
              operationId: crypto.randomUUID(),
              request: {
                resourceId: source.scope.resourceId,
                ...sourceRoles.migrator,
                digest: migrationSet.digest,
                paths: migrationSet.files.map((file) => file.path),
              },
              bundle: await readFile(migrationBundlePath),
              files: expectedSuccess
                ? migrationSource
                : migrationSource.map((file) =>
                    file.path === "drizzle/0000_notes.sql"
                      ? { ...file, content: "DROP TABLE notes;" }
                      : file,
                  ),
              fence: fence([]),
              signal,
            });
            return 0;
          } catch (error) {
            if (expectedSuccess) throw error;
            return 1;
          }
        };
        expect(await runMigration()).toBe(0);
        expect(await runMigration()).toBe(0);

        expect(await runMigration(false)).not.toBe(0);
      } finally {
        await cleanupDatabaseSocket(migrationSocket);
      }

      await enforceManagedDatabaseRolePolicy({
        scope: source.scope,
        database: sourceDatabase,
        operationId: crypto.randomUUID(),
        credentials: sourceRoles,
        administratorBundle: bundle,
        fence: fence([]),
        signal,
      });
      await expect(
        query(
          sourceDatabase.containerId,
          sourceRoles.runtime,
          "SELECT hash FROM public.__drizzle_migrations;",
        ),
      ).rejects.toThrow();
      await expect(
        query(
          sourceDatabase.containerId,
          sourceRoles.runtime,
          "DELETE FROM public.__drizzle_migrations;",
        ),
      ).rejects.toThrow();
      await expect(
        query(
          sourceDatabase.containerId,
          sourceRoles.reader,
          "SELECT hash FROM public.__drizzle_migrations;",
        ),
      ).rejects.toThrow();
      const queryBundlePath = join(directory, "query.js");
      const queryBuild = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          resolve(
            import.meta.dir,
            "../../../apps/api/src/modules/databases/database-query-worker.ts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${queryBundlePath}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await queryBuild.exited) !== 0)
        throw new Error("Read-only query helper did not build");
      const readerSocket = await startDatabaseSocket({
        scope: source.scope,
        database: sourceDatabase,
        socketId: crypto.randomUUID(),
        role: { kind: "reader", ...sourceRoles.reader },
        fence: fence([]),
        signal,
      });
      try {
        const runView = async (
          table: string,
          rows: boolean,
          after?: string,
        ): Promise<{ code: number; output: string }> => {
          try {
            const result = await runDatabaseSocketWorker({
              kind: "query",
              scope: source.scope,
              socket: readerSocket,
              operationId: crypto.randomUUID(),
              request: {
                resourceId: source.scope.resourceId,
                ...sourceRoles.reader,
                rows,
                table,
                ...(after === undefined ? {} : { after }),
              },
              bundle: await readFile(queryBundlePath),
              fence: fence([]),
              signal,
            });
            return { code: 0, output: JSON.stringify(result) };
          } catch {
            return { code: 1, output: "" };
          }
        };
        const viewed = await runView("notes", true);
        expect(viewed.code).toBe(0);
        const rowView = JSON.parse(viewed.output) as {
          tables: string[];
          rows: string[][];
          nextKey: string | null;
          sample: boolean;
        };
        expect(rowView.tables).not.toContain("__drizzle_migrations");
        expect(rowView.rows[0]).toEqual(["1", "Verified private backup row"]);
        expect(rowView.sample).toBe(false);
        const compound = await runView("compound_notes", true);
        expect(compound.code).toBe(0);
        const compoundView = JSON.parse(compound.output) as {
          columns: Array<{ primary: boolean }>;
          sample: boolean;
          nextKey: string | null;
        };
        expect(compoundView.columns.map((column) => column.primary)).toEqual([
          true,
          true,
          false,
        ]);
        expect(compoundView.sample).toBe(true);
        expect(compoundView.nextKey).toBeNull();
        expect((await runView("compound_notes", true, "1")).code).not.toBe(0);
        expect((await runView("__drizzle_migrations", true)).code).not.toBe(0);
        expect((await runView("notes; DROP TABLE notes;", true)).code).not.toBe(
          0,
        );
        const schemaOnly = await runView("notes", false);
        expect(
          (JSON.parse(schemaOnly.output) as { rows: unknown[] }).rows,
        ).toEqual([]);
        const afterFirst = await runView("notes", true, "1");
        expect(
          (JSON.parse(afterFirst.output) as { rows: unknown[] }).rows,
        ).toEqual([]);
      } finally {
        await cleanupDatabaseSocket(readerSocket);
      }
      for (const targetRole of ["reader", "migrator", "runtime"] as const) {
        const sleeping = query(
          sourceDatabase.containerId,
          sourceRoles[targetRole],
          "SET statement_timeout=0; SELECT pg_sleep(60);",
        ).then(
          () => false,
          () => true,
        );
        let active = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const count = await query(
            sourceDatabase.containerId,
            sourceRoles.administrator,
            `SELECT count(*) FROM pg_stat_activity WHERE usename='${sourceRoles[targetRole].user}' AND query LIKE '%pg_sleep(60)%';`,
          );
          if (count.trim() === "1") {
            active = true;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 50));
        }
        expect(active).toBe(true);
        await terminateManagedDatabaseSessions({
          scope: source.scope,
          database: sourceDatabase,
          operationId: crypto.randomUUID(),
          credentials: sourceRoles,
          administratorBundle: bundle,
          fence: fence([]),
          signal,
          target: targetRole,
        });
        expect(await sleeping).toBe(true);
        expect(
          (
            await query(
              sourceDatabase.containerId,
              sourceRoles.administrator,
              `SELECT count(*) FROM pg_stat_activity WHERE usename='${sourceRoles[targetRole].user}';`,
            )
          ).trim(),
        ).toBe("0");
        expect(
          (
            await query(
              sourceDatabase.containerId,
              sourceRoles.runtime,
              "SELECT count(*) FROM notes;",
            )
          ).trim(),
        ).toBe("1");
      }
      const beforeDigest = await inspectManagedDatabaseSchema({
        scope: source.scope,
        database: sourceDatabase,
        operationId: crypto.randomUUID(),
        credentials: sourceRoles,
        administratorBundle: bundle,
        fence: fence([]),
        signal,
      });
      const archive = await captureManagedDatabaseBackup({
        scope: source.scope,
        database: sourceDatabase,
        operationId: crypto.randomUUID(),
        role: sourceRoles.migrator,
        fence: fence([]),
        signal,
      });
      expect(Buffer.from(archive.subarray(0, 5)).toString()).toBe("PGDMP");
      const context = {
          resourceId: source.scope.resourceId,
          backupId: crypto.randomUUID(),
          schemaDigest: null,
        },
        key = randomBytes(32);
      const saved = await sealDatabaseBackup(directory, key, context, archive);
      const restoredArchive = await openDatabaseBackup(
        directory,
        key,
        context,
        saved.sha256,
      );
      const rehearsalSource = migrationSource.map((file) => {
        if (file.path === "wrenly.app.json")
          return {
            ...file,
            content: JSON.stringify({
              version: 1,
              database: {
                engine: "postgresql",
                adapter: "drizzle-postgres",
                migrations: [
                  "drizzle/0000_notes.sql",
                  "drizzle/0001_labels.sql",
                ],
              },
            }),
          };
        if (file.path === "drizzle/meta/_journal.json")
          return {
            ...file,
            content: JSON.stringify({
              version: "7",
              dialect: "postgresql",
              entries: [
                {
                  idx: 0,
                  version: "7",
                  when: 1,
                  tag: "0000_notes",
                  breakpoints: true,
                },
                {
                  idx: 1,
                  version: "7",
                  when: 2,
                  tag: "0001_labels",
                  breakpoints: true,
                },
              ],
            }),
          };
        return file;
      });
      rehearsalSource.push({
        path: "drizzle/0001_labels.sql",
        content: "ALTER TABLE notes ADD COLUMN label text;",
      });
      const rehearsalSet = readAppDatabaseManifest(rehearsalSource, "nextjs");
      if (!rehearsalSet) throw new Error("Missing rehearsal migration set");
      const rehearsal = await rehearseDatabaseMigrations({
        projectId: source.scope.projectId,
        resourceId: source.scope.resourceId,
        operationId: crypto.randomUUID(),
        archive: restoredArchive,
        backupSchemaDigest: beforeDigest,
        files: rehearsalSource,
        migrationDigest: rehearsalSet.digest,
        administratorBundle: bundle,
        migrationBundle: await readFile(migrationBundlePath),
        fence: fence([]),
        signal,
      });
      expect(rehearsal.migrationDigest).toBe(rehearsalSet.digest);
      expect(rehearsal.schemaDigest).not.toBe(beforeDigest);
      const unsupportedSource = rehearsalSource.map((file) =>
        file.path === "drizzle/0001_labels.sql"
          ? {
              ...file,
              content: "CREATE VIEW note_view AS SELECT * FROM notes;",
            }
          : file,
      );
      const unsupportedSet = readAppDatabaseManifest(
        unsupportedSource,
        "nextjs",
      );
      if (!unsupportedSet) throw new Error("Missing unsupported migration set");
      const refusedOperation = crypto.randomUUID();
      await expect(
        rehearseDatabaseMigrations({
          projectId: source.scope.projectId,
          resourceId: source.scope.resourceId,
          operationId: refusedOperation,
          archive: restoredArchive,
          backupSchemaDigest: beforeDigest,
          files: unsupportedSource,
          migrationDigest: unsupportedSet.digest,
          administratorBundle: bundle,
          migrationBundle: await readFile(migrationBundlePath),
          fence: fence([]),
          signal,
        }),
      ).rejects.toThrow();
      expect(
        await docker.listContainers({
          all: true,
          filters: {
            label: [`io.wrenly.database-id=${refusedOperation}`],
          },
        }),
      ).toHaveLength(0);
      expect(
        (
          await docker.listVolumes({
            filters: {
              label: [`io.wrenly.database-id=${refusedOperation}`],
            },
          })
        ).Volumes ?? [],
      ).toHaveLength(0);
      expect(
        await inspectManagedDatabaseSchema({
          scope: source.scope,
          database: sourceDatabase,
          operationId: crypto.randomUUID(),
          credentials: sourceRoles,
          administratorBundle: bundle,
          fence: fence([]),
          signal,
        }),
      ).toBe(beforeDigest);
      const targetDatabase = await createManagedDatabase({
        ...target,
        fence: fence([]),
        signal,
      });
      await provisionManagedDatabaseRoles({
        scope: target.scope,
        database: targetDatabase,
        operationId: crypto.randomUUID(),
        credentials: targetRoles,
        administratorBundle: bundle,
        fence: fence([]),
        signal,
      });
      await expect(
        restoreDisposableDatabaseBackup({
          scope: source.scope,
          database: sourceDatabase,
          operationId: crypto.randomUUID(),
          role: sourceRoles.migrator,
          archive,
          fence: fence([]),
          signal,
        }),
      ).rejects.toThrow();
      await restoreDisposableDatabaseBackup({
        scope: target.scope,
        database: targetDatabase,
        operationId: target.operationId,
        role: targetRoles.migrator,
        archive: restoredArchive,
        fence: fence([]),
        signal,
      });
      await enforceManagedDatabaseRolePolicy({
        scope: target.scope,
        database: targetDatabase,
        operationId: crypto.randomUUID(),
        credentials: targetRoles,
        administratorBundle: bundle,
        fence: fence([]),
        signal,
      });
      const afterDigest = await inspectManagedDatabaseSchema({
        scope: target.scope,
        database: targetDatabase,
        operationId: crypto.randomUUID(),
        credentials: targetRoles,
        administratorBundle: bundle,
        fence: fence([]),
        signal,
      });
      expect(afterDigest).toBe(beforeDigest);
      expect(
        await query(
          targetDatabase.containerId,
          targetRoles.runtime,
          "INSERT INTO notes (body) VALUES ('Runtime after restore'); SELECT count(*) FROM notes;",
        ),
      ).toContain("2");
      await expect(
        query(
          targetDatabase.containerId,
          targetRoles.runtime,
          "INSERT INTO public.__drizzle_migrations (hash,created_at) VALUES ('forged',2);",
        ),
      ).rejects.toThrow();
      expect(
        await query(
          targetDatabase.containerId,
          targetRoles.reader,
          "SELECT body FROM notes;",
        ),
      ).toContain("Verified private backup row");
      expect(
        await query(
          sourceDatabase.containerId,
          sourceRoles.reader,
          "SELECT count(*) FROM notes;",
        ),
      ).toContain("1");
    } finally {
      await cleanup(source.scope);
      await cleanup(target.scope);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
  test("lost acknowledgement preserves partial provisioning and refuses a fresh initializer", async () => {
    const input = fixture(),
      original = fence([]);
    const ownership: DatabaseRuntimeFence = {
      ...original,
      acknowledgeEffect: async (effect) => {
        if (effect.kind === "create-volume")
          throw new Error("Lost acknowledgement");
        await original.acknowledgeEffect(effect);
      },
    };
    try {
      await expect(
        createManagedDatabase({
          ...input,
          fence: ownership,
          signal: AbortSignal.timeout(10_000),
        }),
      ).rejects.toThrow("persistent volume creation");
      const names = managedDatabaseNames(input.scope);
      expect(
        (await docker.getVolume(names.volume).inspect()).Labels?.[
          "io.wrenly.database-id"
        ],
      ).toBe(input.scope.resourceId);
      await expect(
        createManagedDatabase({
          ...input,
          operationId: crypto.randomUUID(),
          fence: fence([]),
          signal: AbortSignal.timeout(10_000),
        }),
      ).rejects.toThrow("preflight");
      expect((await docker.getVolume(names.volume).inspect()).Name).toBe(
        names.volume,
      );
    } finally {
      await cleanup(input.scope);
    }
  });
  test("initializes privately without saved passwords and preserves real rows across stop/start", async () => {
    const input = fixture(),
      events: string[] = [],
      ownership = fence(events),
      signal = AbortSignal.timeout(90_000);
    try {
      const identity = await createManagedDatabase({
        ...input,
        fence: ownership,
        signal,
      });
      expect(identity.volumeName).toBe(
        managedDatabaseNames(input.scope).volume,
      );
      const info = await docker.getContainer(identity.containerId).inspect();
      expect(JSON.stringify(info.Config)).not.toContain(
        input.administrator.password,
      );
      expect(info.Config.User).toBe("70:70");
      expect(info.HostConfig.ReadonlyRootfs).toBe(true);
      expect(info.HostConfig.CapDrop).toContain("ALL");
      expect(info.HostConfig.PortBindings ?? {}).toEqual({});
      expect(
        await query(
          identity.containerId,
          input.administrator,
          "CREATE TABLE notes (id integer PRIMARY KEY, body text); INSERT INTO notes VALUES (1, 'persisted fixture'); SELECT body FROM notes;",
        ),
      ).toContain("persisted fixture");
      await setManagedDatabaseRunning(
        input.scope,
        identity,
        false,
        ownership,
        signal,
      );
      expect(
        (await docker.getContainer(identity.containerId).inspect()).State
          .Running,
      ).toBe(false);
      await setManagedDatabaseRunning(
        input.scope,
        identity,
        true,
        ownership,
        signal,
      );
      expect(
        await query(
          identity.containerId,
          input.administrator,
          "SELECT body FROM notes WHERE id = 1",
        ),
      ).toContain("persisted fixture");
      expect(
        (await inspectManagedDatabase(input.scope, identity)).address,
      ).not.toBe("");
      expect(events).toEqual([
        "before:create-network",
        "after:create-network",
        "before:create-volume",
        "after:create-volume",
        "before:initialize",
        "after:initialize",
        "before:create-container",
        "after:create-container",
        "before:start",
        "after:start",
        "before:stop",
        "after:stop",
        "before:start",
        "after:start",
      ]);
      await expect(
        createManagedDatabase({
          ...input,
          operationId: crypto.randomUUID(),
          fence: ownership,
          signal,
        }),
      ).rejects.toThrow("preflight");
      await expect(
        inspectManagedDatabase(
          { ...input.scope, projectId: crypto.randomUUID() },
          identity,
        ),
      ).rejects.toThrow("inspection");
      await docker
        .getContainer(identity.containerId)
        .remove({ force: true, v: true });
      await expect(
        setManagedDatabaseRunning(
          input.scope,
          identity,
          true,
          ownership,
          signal,
        ),
      ).rejects.toThrow("restart");
      expect((await docker.getVolume(identity.volumeName).inspect()).Name).toBe(
        identity.volumeName,
      );
    } catch (error) {
      const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: [`io.wrenly.database-id=${input.scope.resourceId}`],
        }),
      });
      const diagnostics: string[] = [];
      for (const item of containers)
        diagnostics.push(
          (
            await docker
              .getContainer(item.Id)
              .logs({ stdout: true, stderr: true, tail: 30 })
          )
            .toString()
            .replaceAll(input.administrator.password, "[redacted]"),
        );
      throw new Error(
        `${error instanceof Error ? error.message : "Fixture failed"}\n${error instanceof Error && error.cause instanceof Error ? error.cause.message : ""}\n${diagnostics.join("\n")}`,
        { cause: error },
      );
    } finally {
      await cleanup(input.scope);
    }
  }, 120_000);
  test("revoked ownership before effects leaves no resources", async () => {
    const input = fixture();
    try {
      await expect(
        createManagedDatabase({
          ...input,
          signal: AbortSignal.timeout(10_000),
          fence: {
            ...fence([]),
            assertHeld: async () => {
              throw new Error("Lease lost");
            },
          },
        }),
      ).rejects.toThrow("preflight");
      const containers = await docker.listContainers({
        all: true,
        filters: JSON.stringify({
          label: [`io.wrenly.database-id=${input.scope.resourceId}`],
        }),
      });
      expect(containers).toHaveLength(0);
      await expect(
        docker.getVolume(managedDatabaseNames(input.scope).volume).inspect(),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await cleanup(input.scope);
    }
  });
  test("Postgres.js and PHP PDO use authenticated sockets from containers with no IP network", async () => {
    const input = fixture(),
      ownership = fence([]),
      signal = AbortSignal.timeout(90_000);
    let socket: DatabaseSocketIdentity | undefined;
    const directory = await mkdtemp(join(tmpdir(), "wrenly-database-client-"));
    try {
      const identity = await createManagedDatabase({
        ...input,
        fence: ownership,
        signal,
      });
      const user = `wrenly_${input.scope.resourceId.replaceAll("-", "")}_runtime`,
        password = randomBytes(32).toString("hex");
      await query(
        identity.containerId,
        input.administrator,
        `CREATE TABLE notes (id integer PRIMARY KEY, body text); CREATE ROLE ${user} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'; GRANT CONNECT ON DATABASE app TO ${user}; GRANT USAGE ON SCHEMA public TO ${user}; GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO ${user};`,
      );
      socket = await startDatabaseSocket({
        scope: input.scope,
        database: identity,
        socketId: crypto.randomUUID(),
        role: { kind: "runtime", user, password },
        fence: ownership,
        signal,
      });
      if (process.env.WRENLY_TEST_DATABASE_PREVIEW_RUNTIME === "true") {
        await verifyPreparedPreview(input.scope, socket, { user, password });
        await query(identity.containerId, input.administrator, "DELETE FROM notes WHERE id IN (6,7)");
      }
      const info = await docker.getContainer(socket.containerId).inspect();
      expect(JSON.stringify(info.Config)).not.toContain(password);
      await expect(
        cleanupDatabaseSocket({ ...socket, projectId: crypto.randomUUID() }),
      ).rejects.toThrow("cleanup");

      expect(info.HostConfig.Sysctls["net.ipv4.ip_forward"]).toBe("0");
      expect(info.HostConfig.PortBindings ?? {}).toEqual({});
      const bundle = await Bun.build({
        entrypoints: [
          resolve(
            import.meta.dir,
            "../../db/tests/fixtures/database-socket-client.ts",
          ),
        ],
        target: "bun",
        env: "disable",
        alias: {
          postgres: Bun.resolveSync(
            "postgres",
            resolve(import.meta.dir, "../../db"),
          ),
        },
      });
      if (!bundle.success || !bundle.outputs[0])
        throw new Error("Fixture client bundle failed");
      const path = join(directory, "client.js");
      await writeFile(path, await bundle.outputs[0].text());
      const runClient = async (
        framework: "nextjs" | "laravel",
        suppliedPassword: string,
      ): Promise<{ code: number; output: string }> => {
        const php =
          '$v=json_decode(stream_get_contents(STDIN),true)["environment"];try{$p=new PDO("pgsql:host=".$v["DB_HOST"].";port=".$v["DB_PORT"].";dbname=".$v["DB_DATABASE"],$v["DB_USERNAME"],$v["DB_PASSWORD"],[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);$p->beginTransaction();$s=$p->prepare("INSERT INTO notes VALUES (?, ?)");$s->execute([3,"PDO socket"]);$p->commit();echo "PDO prepared transaction passed.";}catch(Throwable $e){fwrite(STDERR,"Socket query failed.");exit(1);}';
        const child = Bun.spawn(
          [
            "docker",
            "--host",
            "unix:///var/run/docker.sock",
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--read-only",
            "--user",
            "65534:65534",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true",
            "--memory=128m",
            "--cpus=0.5",
            "--pids-limit=32",
            "--mount",
            `type=volume,source=${socket!.volumeName},target=/run/wrenly-database,readonly`,
            ...(framework === "nextjs"
              ? [
                  "--mount",
                  `type=bind,source=${path},target=/client.js,readonly`,
                  "--entrypoint",
                  "bun",
                  "oven/bun:alpine",
                  "--no-env-file",
                  "/client.js",
                ]
              : [
                  "--entrypoint",
                  "php",
                  "wrenly/laravel-runtime:13-php8.4",
                  "-r",
                  php,
                ]),
          ],
          { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        );
        const environment = applicationDatabaseEnvironment(framework, input.scope.resourceId, { user, password: suppliedPassword });
        child.stdin.write(JSON.stringify({ environment }));
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 10_000);
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          return { code, output: stdout + stderr };
        } finally {
          clearTimeout(timer);
        }
      };
      const next = await runClient("nextjs", password);
      expect(next).toEqual({
        code: 0,
        output:
          "Postgres.js prepared transaction and blocked IP egress passed.\n",
      });
      const php = await runClient("laravel", password);
      expect(php).toEqual({
        code: 0,
        output: "PDO prepared transaction passed.",
      });
      expect((await runClient("laravel", "f".repeat(64))).code).not.toBe(0);
      // Join the previously separate database-driver and startup-guardian checks.
      // Tiny fixture applications exercise real CRUD before HTTP readiness; they
      // do not stand in for full generated-framework/revision validation.
      const applicationBundle = await Bun.build({
        entrypoints: [join(import.meta.dir, "fixtures/database-application-bootstrap.ts")],
        target: "bun", env: "disable",
      });
      if (!applicationBundle.success || !applicationBundle.outputs[0]) throw new Error("Trusted startup bundle unavailable");
      const bootstrap = join(directory, "bootstrap.js");
      await writeFile(bootstrap, await applicationBundle.outputs[0].text());
      const publicDirectory = join(directory, "public");
      await mkdir(publicDirectory, { mode: 0o755 });
      await writeFile(join(publicDirectory, "index.php"), `<?php
        try {
          $p=new PDO('pgsql:host='.getenv('DB_HOST').';port='.getenv('DB_PORT').';dbname='.getenv('DB_DATABASE'),getenv('DB_USERNAME'),getenv('DB_PASSWORD'),[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
          $p->beginTransaction();
          $p->exec("INSERT INTO notes VALUES (5, 'PHP HTTP socket')");
          $p->exec("UPDATE notes SET body = 'Updated PHP' WHERE id = 5");
          if($p->query('SELECT body FROM notes WHERE id = 5')->fetchColumn()!=='Updated PHP')throw new Exception('read failed');
          $p->exec('DELETE FROM notes WHERE id = 5');
          $p->exec("INSERT INTO notes VALUES (5, 'PHP HTTP socket')");
          $p->commit(); echo 'Database CRUD verified';
        } catch(Throwable $e) { http_response_code(500); echo 'Database validation failed'; }
      `);
      for (const [framework, validPassword] of [
        ["nextjs", true], ["laravel", true], ["nextjs", false], ["laravel", false],
      ] as const) {
        const child = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", "run", "--rm", "--interactive",
          "--sig-proxy=false", "--network=none", "--read-only", "--user=0:0", "--cap-drop=ALL",
          "--cap-add=SETUID", "--cap-add=SETGID", "--security-opt=no-new-privileges:true",
          "--memory=512m", "--cpus=0.5", "--pids-limit=64", "--log-driver=none",
          "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
          "--tmpfs", "/app/bootstrap/cache:rw,nosuid,nodev,size=8m,uid=1000,gid=1000",
          "--tmpfs", "/app/storage:rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
          "--mount", `type=volume,source=${socket.volumeName},target=/run/wrenly-database,readonly`,
          "--mount", `type=bind,source=${bootstrap},target=/wrenly/bootstrap.js,readonly`,
          "--mount", framework === "nextjs"
            ? `type=bind,source=${path},target=/app/node_modules/next/dist/bin/next,readonly`
            : `type=bind,source=${publicDirectory},target=/app/public,readonly`,
          "--entrypoint=bun", framework === "nextjs" ? socket.imageId : "wrenly/laravel-runtime:13-php8.4",
          "--no-env-file", "/wrenly/bootstrap.js"], {
          stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        });
        child.stdin.write(JSON.stringify({ framework, resourceId: input.scope.resourceId,
          role: { user, password: validPassword ? password : "f".repeat(64) }, lifetimeMs: 4000 }));
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
          // A failed driver may exit before the guardian deadline, or be stopped
          // by it while waiting. Neither outcome may emit a readiness marker.
          if (validPassword) expect(code).toBe(137);
          else expect([125, 137]).toContain(code);
          expect(output).toBe(validPassword ? `${DATABASE_APPLICATION_READY}\n` : "");
        } finally { clearTimeout(timer); }
      }
      expect(
        await query(
          identity.containerId,
          input.administrator,
          "SELECT count(*) FROM notes",
        ),
      ).toContain("4");
      const preparation = await docker.createContainer({ Image: socket.imageId, User: "0:0", Entrypoint: [],
        Cmd: ["sh", "-ec", "mkdir -p /app/node_modules/next/dist/bin && printf '%s' 'Bun.serve({port:3000,fetch:()=>new Response(\"ready\")})' > /app/node_modules/next/dist/bin/next"],
        HostConfig: { NetworkMode: "none", CapDrop: ["ALL"], Memory: 128 * 1024 ** 2, NanoCpus: 500_000_000 } });
      let preparedImage: string | undefined;
      try {
        await preparation.start();
        expect((await preparation.wait()).StatusCode).toBe(0);
        preparedImage = (await preparation.commit({ changes: ["USER 1000:1000", "WORKDIR /app",
          `LABEL io.wrenly.deployment-id=${input.scope.resourceId}`, "LABEL io.wrenly.artifact-role=runtime",
          "LABEL io.wrenly.artifact-workspace-version=2"] })).Id;
        const cleanupEvents: string[] = [];
        const check = {
          scope: input.scope, sourceResourceId: crypto.randomUUID(), operationId: input.scope.resourceId,
          framework: "nextjs" as const, imageId: preparedImage, socket, role: { user, password },
          bootstrapBundle: new Uint8Array(await applicationBundle.outputs[0].arrayBuffer()), lifetimeMs: 10_000,
          fence: ownership, signal,
          cleanup: { assertHeld: ownership.assertHeld,
            beforeCleanup: async (name: string): Promise<void> => { cleanupEvents.push(`before:${name}`); },
            acknowledgeCleanup: async (name: string): Promise<void> => { cleanupEvents.push(`after:${name}`); } },
        };
        expect(await checkDisposableApplicationHttp(check)).toEqual({ httpReady: true });
        expect(cleanupEvents).toEqual([`before:wrenly-database-application-${input.scope.resourceId}`,
          `after:wrenly-database-application-${input.scope.resourceId}`]);
        await expect(docker.getContainer(`wrenly-database-application-${input.scope.resourceId}`).inspect()).rejects.toMatchObject({ statusCode: 404 });
        const validationId = crypto.randomUUID();
        const validationImage = (await preparation.commit({ changes: ["USER 1000:1000", "WORKDIR /app",
          `LABEL io.wrenly.deployment-id=${validationId}`, "LABEL io.wrenly.artifact-role=runtime",
          "LABEL io.wrenly.artifact-workspace-version=2"] })).Id;
        try {
          const files = [
            { path: "wrenly.app.json", content: JSON.stringify({ version: 1, database: {
              engine: "postgresql", adapter: "drizzle-postgres", migrations: ["drizzle/0000_notes.sql"],
            } }) },
            { path: "drizzle/0000_notes.sql", content: "CREATE TABLE notes (id integer PRIMARY KEY, body text NOT NULL);" },
            { path: "drizzle/meta/_journal.json", content: JSON.stringify({ version: "7", dialect: "postgresql",
              entries: [{ idx: 0, version: "7", tag: "0000_notes", when: 1, breakpoints: true }] }) },
          ];
          const reviewed = readAppDatabaseManifest(files, "nextjs")!;
          const cleanupEvents: string[] = [];
          const result = await validateFreshDatabaseApplication({ framework: "nextjs", projectId: input.scope.projectId,
            sourceResourceId: input.scope.resourceId, operationId: validationId, files,
            migrationDigest: reviewed.digest, imageId: validationImage, remainingMs: 60_000, fence: fence([]), signal,
            cleanup: { assertHeld: async () => {},
              beforeCleanup: async (kind, id) => { cleanupEvents.push(`before:${kind}:${id}`); },
              acknowledgeCleanup: async (kind, id) => { cleanupEvents.push(`after:${kind}:${id}`); } } });
          expect(result).toMatchObject({ migrationDigest: reviewed.digest, httpReady: true });
          expect(result.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
          expect(cleanupEvents.filter(event => event.startsWith("after:"))).toHaveLength(4);
          await expect(docker.getContainer(`wrenly-database-${validationId}`).inspect()).rejects.toMatchObject({ statusCode: 404 });
          await expect(docker.getVolume(`wrenly-database-${validationId}-data`).inspect()).rejects.toMatchObject({ statusCode: 404 });
          await expect(docker.getNetwork(`wrenly-database-${validationId}-network`).inspect()).rejects.toMatchObject({ statusCode: 404 });
        } finally { await docker.getImage(validationImage).remove({ force: false }); }
        await expect(checkDisposableApplicationHttp({ ...check, sourceResourceId: input.scope.resourceId })).rejects.toThrow("application HTTP check");
        await expect(checkDisposableApplicationHttp({ ...check, operationId: crypto.randomUUID() })).rejects.toThrow("application HTTP check");
        expect(cleanupEvents).toHaveLength(2);
        let primaryAcknowledged = false;
        await expect(checkDisposableApplicationHttp({ ...check,
          fence: { ...ownership, beforeEffect: async () => {},
            acknowledgeEffect: async () => { primaryAcknowledged = true; } },
          cleanup: { ...check.cleanup, acknowledgeCleanup: async () => { throw new Error("Fixture cleanup save failed"); } },
        })).rejects.toThrow("application check cleanup");
        expect(primaryAcknowledged).toBe(false);
        await expect(docker.getContainer(`wrenly-database-application-${input.scope.resourceId}`).inspect()).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await preparation.remove({ force: true, v: true });
        if (preparedImage) await docker.getImage(preparedImage).remove({ force: false });
      }
      await cleanupDatabaseSocket(socket);
      await cleanupDatabaseSocket(socket);
      socket = undefined;
    } finally {
      if (socket) await cleanupDatabaseSocket(socket);
      await cleanup(input.scope);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
