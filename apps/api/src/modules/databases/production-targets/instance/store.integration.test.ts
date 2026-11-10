/** Opt-in acceptance against a dedicated disposable control database, never an existing instance. */
import { hasMemberDatabaseWork } from "../../database-activity";
import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as schema from "@wrenly/db/schema";
import {
  admitInstanceProductionConnection,
  readInstanceProductionConnection,
  claimInstanceProductionConnection,
  loadInstanceProductionConnection,
  finishInstanceProductionConnection,
  acknowledgeInstanceConnectionCheck,
} from "./store";
const url = process.env.WRENLY_TEST_INSTANCE_CONNECTION_URL;
if (url) {
  const value = new URL(url);
  if (
    value.hostname !== "127.0.0.1" ||
    value.pathname !== "/wrenly_instance_connection_test"
  )
    throw new Error(
      "Use the dedicated disposable instance connection database",
    );
}
const client = postgres(
  url ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  { max: 1 },
);
const database = drizzle(client, { schema });
const check = url ? test : test.skip;
const principal = {
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
};
const other = {
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
};
let directory = "";
const target = {
  version: 1 as const,
  environment: "production" as const,
  host: "apps.internal.test",
  port: 5432,
  database: "maintenance",
  sslmode: "verify-full" as const,
};
function input(expectedConnectionId: string | null = null) {
  return {
    requestId: crypto.randomUUID(),
    expectedConnectionId,
    confirmTarget: true as const,
    target,
    credential: { user: "postgres", password: "fixture-private-password" },
  };
}
const verification = {
  status: "verified" as const,
  inspection: {
    clusterId: "123456789",
    database: "maintenance",
    setupRole: "postgres",
    serverVersion: 170000,
  },
  pinned: { target, addresses: ["10.20.30.40"] },
};
beforeAll(async () => {
  if (!url) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-instance-connection-"));
  await migrate(database, {
    migrationsFolder: resolve(
      import.meta.dir,
      "../../../../../../../packages/db/migrations",
    ),
  });
  for (const actor of [principal, other]) {
    await database.insert(schema.user).values({
      id: actor.userId,
      email: `${actor.userId}@example.test`,
      name: "Fixture user",
      accessRevision: actor.revision,
    });
    await database.insert(schema.session).values({
      id: actor.sessionId,
      userId: actor.userId,
      token: crypto.randomUUID(),
      accessRevision: actor.revision,
      expiresAt: new Date(Date.now() + 600_000),
    });
  }
  await database
    .insert(schema.instanceSetup)
    .values({ id: 1, ownerId: principal.userId })
    .onConflictDoUpdate({
      target: schema.instanceSetup.id,
      set: { ownerId: principal.userId },
    });
});
beforeEach(async () => {
  if (url) await database.delete(schema.productionDatabaseConnections);
});
afterAll(async () => {
  await client.end({ timeout: 1 });
  if (directory) await rm(directory, { recursive: true, force: true });
});
check(
  "one instance connection is independent of projects, encrypted and exact-replay protected",
  async () => {
    const request = input();
    const first = await admitInstanceProductionConnection(
      database,
      principal,
      request,
      directory,
    );
    expect(
      (
        await admitInstanceProductionConnection(
          database,
          principal,
          request,
          directory,
        )
      ).connectionId,
    ).toBe(first.connectionId);
    await expect(
      admitInstanceProductionConnection(
        database,
        principal,
        {
          ...request,
          credential: { ...request.credential, password: "changed" },
        },
        directory,
      ),
    ).rejects.toThrow();
    const [saved] = await database
      .select()
      .from(schema.productionDatabaseConnections);
    expect(JSON.stringify(saved)).not.toContain(request.credential.password);
    expect(await database.select().from(schema.projects)).toHaveLength(0);
    const status = await readInstanceProductionConnection(database, principal);
    expect(Object.keys(status ?? {}).sort()).toEqual([
      "connectionId",
      "status",
      "target",
      "verified",
    ]);
    expect(JSON.stringify(status)).not.toContain("credential");
    expect(
      (
        await readInstanceProductionConnection(
          database,
          principal,
          request.requestId,
        )
      )?.connectionId,
    ).toBe(first.connectionId);
    expect(
      await readInstanceProductionConnection(
        database,
        principal,
        crypto.randomUUID(),
      ),
    ).toBeNull();
    const claim = await claimInstanceProductionConnection(database);
    if (!claim) throw new Error("Missing claim");
    expect(
      (await loadInstanceProductionConnection(database, claim, directory))
        .credential,
    ).toEqual(request.credential);
    await finishInstanceProductionConnection(database, claim, verification);
    expect(
      (await readInstanceProductionConnection(database, principal))?.status,
    ).toBe("verified");
    expect(await database.select().from(schema.appDatabases)).toHaveLength(0);
  },
);
check(
  "members and stale sessions cannot read, admit or decrypt instance setup",
  async () => {
    await expect(
      admitInstanceProductionConnection(database, other, input(), directory),
    ).rejects.toThrow();
    await expect(
      readInstanceProductionConnection(database, other),
    ).rejects.toThrow();
    await admitInstanceProductionConnection(
      database,
      principal,
      input(),
      directory,
    );
    const claim = await claimInstanceProductionConnection(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      loadInstanceProductionConnection(
        database,
        { ...claim, token: crypto.randomUUID() },
        directory,
      ),
    ).rejects.toThrow();
    await database
      .update(schema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.session.id, principal.sessionId));
    try {
      await expect(
        loadInstanceProductionConnection(database, claim, directory),
      ).rejects.toThrow();
      await expect(
        finishInstanceProductionConnection(database, claim, verification),
      ).rejects.toThrow();
    } finally {
      await database
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() + 600_000) })
        .where(eq(schema.session.id, principal.sessionId));
    }
  },
);
check(
  "expired checks require explicit closure and cannot complete from their old claim",
  async () => {
    const first = await admitInstanceProductionConnection(
      database,
      principal,
      input(),
      directory,
    );
    const claim = await claimInstanceProductionConnection(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      acknowledgeInstanceConnectionCheck(
        database,
        principal,
        first.connectionId,
      ),
    ).rejects.toThrow();
    await database
      .update(schema.productionDatabaseConnections)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.productionDatabaseConnections.id, first.connectionId));
    expect(await claimInstanceProductionConnection(database)).toBeNull();
    expect(
      (await readInstanceProductionConnection(database, principal))?.status,
    ).toBe("needs_review");
    await expect(
      finishInstanceProductionConnection(database, claim, verification),
    ).rejects.toThrow();
    await acknowledgeInstanceConnectionCheck(
      database,
      principal,
      first.connectionId,
    );
    expect(
      (
        await acknowledgeInstanceConnectionCheck(
          database,
          principal,
          first.connectionId,
        )
      ).replayed,
    ).toBe(true);
    const next = await admitInstanceProductionConnection(
      database,
      principal,
      input(first.connectionId),
      directory,
    );
    expect(next.connectionId).not.toBe(first.connectionId);
  },
);
check(
  "new connection revisions preserve old encrypted facts and reject stale expectations",
  async () => {
    const first = await admitInstanceProductionConnection(
      database,
      principal,
      input(),
      directory,
    );
    const claim = await claimInstanceProductionConnection(database);
    if (!claim) throw new Error("Missing claim");
    await finishInstanceProductionConnection(database, claim, verification);
    const [before] = await database
      .select()
      .from(schema.productionDatabaseConnections)
      .where(eq(schema.productionDatabaseConnections.id, first.connectionId));
    const next = await admitInstanceProductionConnection(
      database,
      principal,
      input(first.connectionId),
      directory,
    );
    await expect(
      admitInstanceProductionConnection(
        database,
        principal,
        input(first.connectionId),
        directory,
      ),
    ).rejects.toThrow();
    const [after] = await database
      .select()
      .from(schema.productionDatabaseConnections)
      .where(eq(schema.productionDatabaseConnections.id, first.connectionId));
    expect(after).toEqual(before);
    expect(next.connectionId).not.toBe(first.connectionId);
  },
);
check(
  "mismatched verified targets cannot be acknowledged as successful",
  async () => {
    await admitInstanceProductionConnection(
      database,
      principal,
      input(),
      directory,
    );
    const claim = await claimInstanceProductionConnection(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      finishInstanceProductionConnection(database, claim, {
        ...verification,
        pinned: {
          ...verification.pinned,
          target: { ...target, host: "other.internal.test" },
        },
      }),
    ).rejects.toThrow();
    expect(
      (await readInstanceProductionConnection(database, principal))?.status,
    ).toBe("checking");
  },
);

check(
  "queued and uncertain instance checks fence account work until explicitly settled",
  async () => {
    const saved = await admitInstanceProductionConnection(
      database,
      principal,
      input(),
      directory,
    );
    expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(true);
    expect(await hasMemberDatabaseWork(database, other.userId)).toBe(false);
    const claim = await claimInstanceProductionConnection(database);
    if (!claim) throw new Error("Missing claim");
    await finishInstanceProductionConnection(database, claim, {
      status: "interrupted",
    });
    expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(true);
    await acknowledgeInstanceConnectionCheck(
      database,
      principal,
      saved.connectionId,
    );
    expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(false);
  },
);
