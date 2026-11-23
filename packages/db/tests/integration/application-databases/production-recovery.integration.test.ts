/** Native read-only inspection of interrupted creation; every resource belongs to the disposable cluster fixture. */
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
import { inspectProductionProjectPhase } from "../../../src/application-databases/production-cluster/recovery";
const url = process.env.WRENLY_TEST_APP_CLUSTER_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/wrenly_production_roles_test"
  )
    throw new Error("Use the disposable app-cluster test target");
}
const check = url ? test : test.skip;
const client = postgres(
  url ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  { max: 1, connection: { statement_timeout: 5000 } },
);
const database = drizzle(client);
const clients: ReturnType<typeof postgres>[] = [];
let clusterId = "";
const identity = () => ({
  appClusterId: clusterId,
  controlClusterId: clusterId === "1" ? "2" : "1",
});
function projectConnection(name: string) {
  const selected = new URL(url!);
  selected.pathname = `/${name}`;
  const connection = postgres(selected.toString(), {
    max: 1,
    connection: { statement_timeout: 5000 },
  });
  clients.push(connection);
  return drizzle(connection);
}
beforeAll(async () => {
  if (url) {
    const rows = await database.execute(
      sql`select system_identifier::text as id from pg_catalog.pg_control_system()`,
    );
    clusterId = String(rows[0]?.id);
  }
});
afterAll(async () => {
  await Promise.all(
    clients.map((connection) => connection.end({ timeout: 1 })),
  );
  await client.end({ timeout: 1 });
});
check(
  "each untouched phase is absent and each exact completed phase is confirmed without replay",
  async () => {
    const id = crypto.randomUUID(),
      credentials = createProductionProjectCredentials(id);
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "roles",
      ),
    ).toBe("absent");
    await createProductionProjectRoles(database, identity(), id, credentials);
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "roles",
      ),
    ).toBe("confirmed");
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "database",
      ),
    ).toBe("absent");
    await createProductionProjectDatabase(
      database,
      identity(),
      id,
      credentials,
    );
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "database",
      ),
    ).toBe("confirmed");
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "connections",
      ),
    ).toBe("absent");
    await enableProductionProjectConnections(
      database,
      identity(),
      id,
      credentials,
    );
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "connections",
      ),
    ).toBe("confirmed");
    const project = projectConnection(credentials.database);
    expect(
      await inspectProductionProjectPhase(
        project,
        identity(),
        id,
        credentials,
        "schema",
      ),
    ).toBe("absent");
    await initializeProductionProjectSchema(
      project,
      identity(),
      id,
      credentials,
    );
    expect(
      await inspectProductionProjectPhase(
        project,
        identity(),
        id,
        credentials,
        "schema",
      ),
    ).toBe("confirmed");
    await project.execute(sql`create table public.notes(id integer)`);
    expect(
      await inspectProductionProjectPhase(
        project,
        identity(),
        id,
        credentials,
        "schema",
      ),
    ).toBe("review");
  },
);
check(
  "matching names and flags cannot adopt roles with different minted passwords",
  async () => {
    const id = crypto.randomUUID(),
      original = createProductionProjectCredentials(id),
      foreign = createProductionProjectCredentials(id);
    await createProductionProjectRoles(database, identity(), id, foreign);
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        original,
        "roles",
      ),
    ).toBe("review");
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        foreign,
        "roles",
      ),
    ).toBe("confirmed");
  },
);
check(
  "changed connection grants and control-cluster aliases remain protected",
  async () => {
    const id = crypto.randomUUID(),
      credentials = createProductionProjectCredentials(id);
    await createProductionProjectRoles(database, identity(), id, credentials);
    await createProductionProjectDatabase(
      database,
      identity(),
      id,
      credentials,
    );
    await enableProductionProjectConnections(
      database,
      identity(),
      id,
      credentials,
    );
    await database.execute(
      sql`grant connect on database ${sql.identifier(credentials.database)} to public`,
    );
    expect(
      await inspectProductionProjectPhase(
        database,
        identity(),
        id,
        credentials,
        "connections",
      ),
    ).toBe("review");
    await expect(
      inspectProductionProjectPhase(
        database,
        { appClusterId: clusterId, controlClusterId: clusterId },
        id,
        credentials,
        "connections",
      ),
    ).rejects.toThrow();
  },
);
