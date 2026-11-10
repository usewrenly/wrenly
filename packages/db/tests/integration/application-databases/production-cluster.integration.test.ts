/** Dedicated disposable PostgreSQL 17 cluster only; no control instance or user resource is opened. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { createProductionProjectCredentials } from "../../../src/application-databases/production-cluster/contract";
import {
  createProductionProjectRoles,
  createProductionProjectDatabase,
  enableProductionProjectConnections,
  initializeProductionProjectSchema,
} from "../../../src/application-databases/production-cluster/provisioning";
const url = process.env.WRENLY_TEST_APP_CLUSTER_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/wrenly_production_roles_test"
  )
    throw new Error("Use the disposable app-cluster test target.");
}
const check = url ? test : test.skip;
const client = postgres(
  url ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  { max: 1, connection: { statement_timeout: 5000 } },
);
const database = drizzle(client);
const projects = [crypto.randomUUID(), crypto.randomUUID()].map((id) => ({
  id,
  credentials: createProductionProjectCredentials(id),
}));
let clusterId = "";
const clients: ReturnType<typeof postgres>[] = [];
const identity = (): { appClusterId: string; controlClusterId: string } => ({
  appClusterId: clusterId,
  controlClusterId: clusterId === "1" ? "2" : "1",
});
function connect(name: string, role?: { user: string; password: string }) {
  const selected = new URL(url!);
  selected.pathname = `/${name}`;
  if (role) {
    selected.username = role.user;
    selected.password = role.password;
  }
  const client = postgres(selected.toString(), {
    max: 1,
    connection: { statement_timeout: 5000 },
  });
  clients.push(client);
  return drizzle(client);
}
beforeAll(async () => {
  if (!url) return;
  const rows = await database.execute(
    sql`select system_identifier::text as id from pg_catalog.pg_control_system()`,
  );
  clusterId = String(rows[0]?.id);
});
afterAll(async () => {
  await Promise.all(clients.map((client) => client.end()));
  await client.end();
});
check(
  "two projects get separate initially closed databases without touching other project grants",
  async () => {
    for (const project of projects) {
      await createProductionProjectRoles(
        database,
        identity(),
        project.id,
        project.credentials,
      );
      await createProductionProjectDatabase(
        database,
        identity(),
        project.id,
        project.credentials,
      );
      const rows = await database.execute(
        sql`select datallowconn as allowed from pg_catalog.pg_database where datname=${project.credentials.database}`,
      );
      expect(rows[0]?.allowed).toBe(false);
      await enableProductionProjectConnections(
        database,
        identity(),
        project.id,
        project.credentials,
      );
      await initializeProductionProjectSchema(
        connect(project.credentials.database),
        identity(),
        project.id,
        project.credentials,
      );
    }
  },
);
check(
  "project runtime has CRUD and reader SELECT, but neither can run schema DDL",
  async () => {
    for (const project of projects) {
      const { credentials } = project;
      const migrator = connect(credentials.database, credentials.migrator);
      const runtime = connect(credentials.database, credentials.runtime);
      const reader = connect(credentials.database, credentials.reader);
      await migrator.execute(
        sql`create table public.notes (id serial primary key, body text not null)`,
      );
      await runtime.execute(
        sql`insert into public.notes(body) values ('saved')`,
      );
      const rows = await reader.execute(sql`select body from public.notes`);
      expect(rows[0]?.body).toBe("saved");
      await runtime.execute(sql`update public.notes set body='updated'`);
      expect(
        (await reader.execute(sql`select body from public.notes`))[0]?.body,
      ).toBe("updated");
      await expect(
        Promise.resolve(
          runtime.execute(sql`create table public.forbidden(id integer)`),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          reader.execute(
            sql`insert into public.notes(body) values ('forbidden')`,
          ),
        ),
      ).rejects.toThrow();
      await expect(
        Promise.resolve(
          runtime.execute(sql`create role forbidden_project_role`),
        ),
      ).rejects.toThrow();
      await runtime.execute(sql`delete from public.notes`);
    }
  },
);
check(
  "each project role is denied a connection to the other project database",
  async () => {
    const first = projects[0]!,
      second = projects[1]!;
    for (const role of [
      first.credentials.migrator,
      first.credentials.runtime,
      first.credentials.reader,
    ]) {
      const foreign = connect(second.credentials.database, role);
      await expect(
        Promise.resolve(foreign.execute(sql`select 1`)),
      ).rejects.toThrow();
    }
    await expect(
      Promise.resolve(
        connect(first.credentials.database, second.credentials.runtime).execute(
          sql`select 1`,
        ),
      ),
    ).rejects.toThrow();
  },
);
check(
  "existing resources refuse reprovisioning without rotating credentials or changing data",
  async () => {
    const project = projects[0]!;
    await expect(
      createProductionProjectRoles(
        database,
        identity(),
        project.id,
        project.credentials,
      ),
    ).rejects.toThrow();
    await expect(
      createProductionProjectDatabase(
        database,
        identity(),
        project.id,
        project.credentials,
      ),
    ).rejects.toThrow();
    await expect(
      enableProductionProjectConnections(
        database,
        identity(),
        project.id,
        project.credentials,
      ),
    ).rejects.toThrow();
    await expect(
      initializeProductionProjectSchema(
        connect(project.credentials.database),
        identity(),
        project.id,
        project.credentials,
      ),
    ).rejects.toThrow();
    expect(
      (
        await connect(
          project.credentials.database,
          project.credentials.reader,
        ).execute(sql`select count(*)::integer as total from public.notes`)
      )[0]?.total,
    ).toBe(0);
  },
);
check("control cluster identity is refused before creating roles", async () => {
  const id = crypto.randomUUID(),
    credentials = createProductionProjectCredentials(id);
  await expect(
    createProductionProjectRoles(
      database,
      { appClusterId: clusterId, controlClusterId: clusterId },
      id,
      credentials,
    ),
  ).rejects.toThrow();
  const rows = await database.execute(
    sql`select rolname from pg_catalog.pg_roles where rolname=${credentials.runtime.user}`,
  );
  expect(rows).toHaveLength(0);
});
