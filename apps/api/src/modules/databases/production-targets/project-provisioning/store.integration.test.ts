/** Dedicated disposable control-store acceptance; SQL side effects are tested separately against native PostgreSQL. */
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
  claimInstanceProductionConnection,
  finishInstanceProductionConnection,
} from "../instance/store";
import {
  admitProjectProductionProvision,
  claimProjectProductionProvision,
  beginProjectProductionPhase,
  finishProjectProductionPhase,
} from "./store";
import { claimProductionProvision } from "../provisioning/store";
import { PRODUCTION_PROVISION_PHASES } from "@wrenly/db/production-project-credentials";
const url = process.env.WRENLY_TEST_PROJECT_PROVISION_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/wrenly_project_provision_test"
  )
    throw new Error("Use the disposable project provisioning database");
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
let directory = "";
const target = {
  version: 1 as const,
  environment: "production" as const,
  host: "apps.internal.test",
  port: 5432,
  database: "maintenance",
  sslmode: "verify-full" as const,
};
beforeAll(async () => {
  if (!url) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-project-provision-"));
  await migrate(database, {
    migrationsFolder: resolve(
      import.meta.dir,
      "../../../../../../../packages/db/migrations",
    ),
  });
  await database.insert(schema.user).values({
    id: principal.userId,
    name: "Fixture owner",
    email: `${principal.userId}@example.test`,
    accessRevision: principal.revision,
  });
  await database.insert(schema.session).values({
    id: principal.sessionId,
    userId: principal.userId,
    token: crypto.randomUUID(),
    accessRevision: principal.revision,
    expiresAt: new Date(Date.now() + 600000),
  });
  await database
    .insert(schema.instanceSetup)
    .values({ id: 1, ownerId: principal.userId })
    .onConflictDoUpdate({
      target: schema.instanceSetup.id,
      set: { ownerId: principal.userId },
    });
});
beforeEach(async () => {
  if (url) {
    await database.delete(schema.productionDatabaseProvisions);
    await database.delete(schema.productionDatabaseConnections);
  }
});
afterAll(async () => {
  await client.end({ timeout: 1 });
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const connection = await admitInstanceProductionConnection(
    database,
    principal,
    {
      requestId: crypto.randomUUID(),
      expectedConnectionId: null,
      confirmTarget: true,
      target,
      credential: { user: "postgres", password: "fixture-management-secret" },
    },
    directory,
  );
  const claim = await claimInstanceProductionConnection(database);
  if (!claim) throw new Error("Missing connection claim");
  await finishInstanceProductionConnection(database, claim, {
    status: "verified",
    inspection: {
      clusterId: "123456789",
      database: "maintenance",
      setupRole: "postgres",
      serverVersion: 170000,
    },
    pinned: { target, addresses: ["10.20.30.40"] },
  });
  const [project] = await database
    .insert(schema.projects)
    .values({ userId: principal.userId, name: "Production fixture" })
    .returning();
  if (!project) throw new Error("Missing project");
  return {
    project,
    input: {
      requestId: crypto.randomUUID(),
      expectedRevision: project.accessRevision,
      connectionId: connection.connectionId,
      confirmCreate: true as const,
    },
  };
}
check(
  "project confirmation freezes one verified instance connection and independent encrypted role secrets",
  async () => {
    const { project, input } = await fixture();
    const receipt = await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    expect(
      (
        await admitProjectProductionProvision(
          database,
          principal,
          project.id,
          input,
          directory,
        )
      ).resourceId,
    ).toBe(receipt.resourceId);
    await expect(
      admitProjectProductionProvision(
        database,
        principal,
        project.id,
        { ...input, connectionId: crypto.randomUUID() },
        directory,
      ),
    ).rejects.toThrow();
    const [saved] = await database
      .select()
      .from(schema.productionDatabaseProvisions)
      .where(eq(schema.productionDatabaseProvisions.id, receipt.resourceId));
    expect(saved?.connectionId).toBe(input.connectionId);
    expect(saved?.mode).toBe("cluster");
    expect(await claimProductionProvision(database)).toBeNull();
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing claim");
    const phase = await beginProjectProductionPhase(
      database,
      claim,
      "roles",
      directory,
    );
    expect(phase.server.credential.password).toBe("fixture-management-secret");
    expect(
      new Set([
        phase.credentials.migrator.password,
        phase.credentials.runtime.password,
        phase.credentials.reader.password,
      ]).size,
    ).toBe(3);
    expect(JSON.stringify(saved)).not.toContain(
      phase.credentials.runtime.password,
    );
    await expect(
      beginProjectProductionPhase(database, claim, "roles", directory),
    ).rejects.toThrow();
    await expect(
      beginProjectProductionPhase(database, claim, "database", directory),
    ).rejects.toThrow();
  },
);
check(
  "every phase requires saved intent and advances in order; provisioned never means app-ready",
  async () => {
    const { project, input } = await fixture();
    await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing claim");
    await expect(
      finishProjectProductionPhase(database, claim, "roles", true),
    ).rejects.toThrow();
    for (const [index, phase] of PRODUCTION_PROVISION_PHASES.entries()) {
      await beginProjectProductionPhase(database, claim, phase, directory);
      const saved = await finishProjectProductionPhase(
        database,
        claim,
        phase,
        true,
      );
      expect(saved.completedPhases).toEqual(
        PRODUCTION_PROVISION_PHASES.slice(0, index + 1),
      );
      expect(saved.status).toBe(
        index === PRODUCTION_PROVISION_PHASES.length - 1
          ? "created"
          : "creating",
      );
      await expect(
        beginProjectProductionPhase(database, claim, phase, directory),
      ).rejects.toThrow();
    }
    expect(await database.select().from(schema.appDatabases)).toHaveLength(0);
  },
);
check(
  "unknown SQL preserves its phase, blocks another request and is not reclaimed",
  async () => {
    const { project, input } = await fixture();
    await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing claim");
    await beginProjectProductionPhase(database, claim, "roles", directory);
    await finishProjectProductionPhase(database, claim, "roles", false);
    expect(await claimProjectProductionProvision(database)).toBeNull();
    const [saved] = await database
      .select()
      .from(schema.productionDatabaseProvisions)
      .where(eq(schema.productionDatabaseProvisions.id, claim.id));
    expect(saved?.status).toBe("needs_review");
    expect(saved?.effectPhase).toBe("roles");
    expect(saved?.completedPhases).toEqual([]);
    await expect(
      admitProjectProductionProvision(
        database,
        principal,
        project.id,
        { ...input, requestId: crypto.randomUUID() },
        directory,
      ),
    ).rejects.toThrow();
    await expect(
      beginProjectProductionPhase(database, claim, "roles", directory),
    ).rejects.toThrow();
  },
);
check(
  "expired claims and revoked sessions cannot expose or acknowledge credentials",
  async () => {
    const { project, input } = await fixture();
    await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing claim");
    await database
      .update(schema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.session.id, principal.sessionId));
    try {
      await expect(
        beginProjectProductionPhase(database, claim, "roles", directory),
      ).rejects.toThrow();
    } finally {
      await database
        .update(schema.session)
        .set({ expiresAt: new Date(Date.now() + 600000) })
        .where(eq(schema.session.id, principal.sessionId));
    }
    await database
      .update(schema.productionDatabaseProvisions)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.productionDatabaseProvisions.id, claim.id));
    expect(await claimProjectProductionProvision(database)).toBeNull();
    await expect(
      beginProjectProductionPhase(database, claim, "roles", directory),
    ).rejects.toThrow();
  },
);
