import {
  claimMaintenance,
  advanceMaintenance,
  renewMaintenance,
  recordMaintenanceExpiry,
} from "./claims";
/** Guarded disposable PostgreSQL proof for permission persistence, replay and owner fences. */
import { beforeAll, afterAll, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@wrenly/db/schema";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import { changeMaintenancePermission, loadMaintenanceAuthority } from "./store";
const url = process.env.WRENLY_TEST_PRODUCTION_MAINTENANCE_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/wrenly_production_maintenance_test"
  )
    throw new Error("Use the dedicated disposable maintenance test database.");
}
const client = postgres(
  url ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  { max: 1 },
);
const database = drizzle(client, { schema });
const check = url ? test : test.skip;
const actor = {
  userId: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  revision: crypto.randomUUID(),
};
const projectId = crypto.randomUUID(),
  buildId = crypto.randomUUID(),
  resourceId = crypto.randomUUID(),
  connectionId = crypto.randomUUID(),
  hostId = crypto.randomUUID(),
  deploymentId = crypto.randomUUID(),
  resourceRevision = crypto.randomUUID(),
  accessRevision = crypto.randomUUID(),
  token = crypto.randomUUID();
const envelope = {
  version: 1 as const,
  keyId: "fixture",
  nonce: "fixture",
  tag: "fixture",
  ciphertext: "fixture",
};
const binding: ProductionPublishingBinding = {
  version: 1,
  deploymentId,
  projectId,
  buildId,
  resourceId,
  resourceRevision,
  sourceSha256: "a".repeat(64),
  schemaDigest: "b".repeat(64),
  migrationDigest: "c".repeat(64),
  connectionId,
  clusterId: "123",
  hostConnectionId: hostId,
  dockerId: "fixture-daemon",
  serverId: "fixture-server",
  principal: { ...actor, accessRevision },
};
beforeAll(async () => {
  if (!url) return;
  await migrate(database, {
    migrationsFolder: resolve(
      import.meta.dir,
      "../../../../../../packages/db/migrations",
    ),
  });
  await database.insert(schema.user).values({
    id: actor.userId,
    email: `${actor.userId}@example.test`,
    name: "Fixture",
    accessRevision: actor.revision,
  });
  await database.insert(schema.session).values({
    id: actor.sessionId,
    userId: actor.userId,
    accessRevision: actor.revision,
    token: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 600000),
  });
  await database.insert(schema.projects).values({
    id: projectId,
    userId: actor.userId,
    name: "Fixture",
    stack: "nextjs",
    accessRevision,
  });
  await database.insert(schema.builds).values({
    id: buildId,
    projectId,
    prompt: "fixture",
    status: "success",
    stack: "nextjs",
    files: [],
  });
  await database.insert(schema.productionDatabaseConnections).values({
    id: connectionId,
    actorId: actor.userId,
    sessionId: actor.sessionId,
    accountRevision: actor.revision,
    requestId: crypto.randomUUID(),
    requestIdentity: "fixture",
    target: {
      version: 1,
      environment: "production",
      host: "db.internal.test",
      port: 5432,
      database: "postgres",
      sslmode: "verify-full",
    },
    secret: envelope,
    status: "verified",
    verified: {
      clusterId: "123",
      database: "postgres",
      setupRole: "postgres",
      serverVersion: 170000,
    },
  });
  await database.insert(schema.productionRuntimeHosts).values({
    id: hostId,
    actorId: actor.userId,
    sessionId: actor.sessionId,
    accountRevision: actor.revision,
    requestId: crypto.randomUUID(),
    requestIdentity: "fixture",
    serverId: "fixture-server",
    target: {
      host: "deploy.internal.test",
      port: 22,
      user: "wrenly",
      hostKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
    },
    secret: envelope,
    status: "verified",
    verified: {
      version: 1,
      nonce: crypto.randomUUID(),
      dockerId: "fixture-daemon",
      operatingSystem: "linux",
      architecture: "x86_64",
      helperVersion: 1,
    },
  });
  await database.insert(schema.appDatabases).values({
    id: resourceId,
    projectId,
    environment: "production",
    provider: "postgres-cluster",
    status: "ready",
    revision: resourceRevision,
    secrets: envelope,
    createdBy: actor.userId,
    schemaDigest: binding.schemaDigest,
    providerIdentity: {
      version: "1",
      provider: "postgres-cluster",
      connectionId,
      clusterId: "123",
      database: `wrenly_${resourceId.replaceAll("-", "")}`,
      networkId: "d".repeat(64),
    },
  });
  await database.insert(schema.deploymentResources).values({
    projectId,
    gitInstanceUrl: "http://gitea.fixture",
    repositoryOwner: "fixture",
    repositoryName: "fixture",
    coolifyInstanceUrl: "http://coolify.fixture",
    coolifyProjectUuid: "fixture",
    coolifyServerUuid: "fixture-server",
    coolifyEnvironmentName: "production",
  });
  await database.insert(schema.deployments).values({
    id: deploymentId,
    projectId,
    buildId,
    userId: actor.userId,
    idempotencyKey: crypto.randomUUID(),
    requestIdentity: "fixture",
    stack: "nextjs",
    files: [],
    sourceSha256: binding.sourceSha256,
    status: "preparing",
    claimToken: token,
    leaseExpiresAt: new Date(Date.now() + 600000),
    productionDatabaseBinding: binding,
    productionRuntimeJournal: { version: 1, pending: null, completed: [] },
  });
});

afterAll(async () => {
  await client.end({ timeout: 1 });
});
async function completedPublication(): Promise<void> {
  const now = new Date(Date.now() - 1000);
  const image = `sha256:${"d".repeat(64)}`;
  const facts = [
    {
      step: "http-volume",
      name: `wrenly-deployment-http-${deploymentId}`,
      createdAt: now.toISOString(),
    },
    {
      step: "database-volume",
      name: `wrenly-deployment-db-${deploymentId}`,
      createdAt: now.toISOString(),
    },
    { step: "broker-network", networkId: "e".repeat(64) },
    {
      step: "broker-start",
      containerId: "f".repeat(64),
      imageId: image,
      networkId: "e".repeat(64),
      volumeName: `wrenly-deployment-db-${deploymentId}`,
    },
    {
      step: "service-create",
      serviceId: "fixture-service",
      compositionSha256: "1".repeat(64),
      appImageId: image,
      appRegistryDigest: image,
      ingressRegistryDigest: image,
    },
    { step: "service-start", serviceId: "fixture-service" },
    { step: "application-start", containerId: "2".repeat(64), imageId: image },
    {
      step: "route-verify",
      url: "https://app.example.test/",
      sourceSha256: binding.sourceSha256,
    },
  ];
  let journal: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  for (const fact of facts) {
    journal = beginProductionPublishingEffect(binding, journal, token, now);
    journal = acknowledgeProductionPublishingEffect(
      binding,
      journal,
      { effect: journal.pending, fact, completedAt: now.toISOString() },
      token,
    );
  }
  await database
    .update(schema.deployments)
    .set({
      status: "success",
      claimToken: null,
      leaseExpiresAt: null,
      productionRuntimeJournal: journal,
    })
    .where(eq(schema.deployments.id, deploymentId));
}
function decision(
  revision: string | null = null,
  state: "enabled" | "paused" | "revoked" = "enabled",
) {
  return {
    requestId: crypto.randomUUID(),
    expectedAccessRevision: accessRevision,
    expectedGrantRevision: revision,
    state,
    confirmMaintenance: true,
  };
}
check(
  "only a complete publication can acquire separately confirmed permission",
  async () => {
    await expect(
      changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        decision(),
      ),
    ).rejects.toThrow();
    expect(
      await database
        .select()
        .from(schema.productionRuntimeMaintenance)
        .where(eq(schema.productionRuntimeMaintenance.projectId, projectId)),
    ).toHaveLength(0);
    await completedPublication();
    const input = decision();
    const saved = await changeMaintenancePermission(
      database,
      actor,
      projectId,
      deploymentId,
      input,
    );
    expect(saved.replayed).toBe(false);
    expect(saved.grant.state).toBe("enabled");
    expect(
      await changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        input,
      ),
    ).toEqual({ ...saved, replayed: true });
    await expect(
      changeMaintenancePermission(database, actor, projectId, deploymentId, {
        ...input,
        state: "paused",
      }),
    ).rejects.toThrow("different reviewed");
    await expect(
      changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        decision(),
      ),
    ).rejects.toThrow("changed");
  },
);
check(
  "durable claims retain unknown effects and reject overlapping or revoked execution",
  async () => {
    const [row] = await database
      .select()
      .from(schema.productionRuntimeMaintenance)
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );
    const revision = row!.grant.revision;
    const claim = await claimMaintenance(database, deploymentId, revision);
    await expect(
      claimMaintenance(database, deploymentId, revision),
    ).rejects.toThrow("unfinished");
    for (let i = 0; i < 3; i++) {
      const pending = await advanceMaintenance(database, claim);
      await expect(advanceMaintenance(database, claim)).rejects.toThrow(
        "pending",
      );
      await expect(
        advanceMaintenance(
          database,
          { ...claim, token: crypto.randomUUID() },
          pending.pending!.id,
        ),
      ).rejects.toThrow("claim");
      await renewMaintenance(database, claim);
      await advanceMaintenance(database, claim, pending.pending!.id);
    }
    const uncertain = await claimMaintenance(database, deploymentId, revision);
    const pending = await advanceMaintenance(database, uncertain);
    await database
      .update(schema.productionRuntimeMaintenance)
      .set({ grant: { ...row!.grant, state: "paused" } })
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );
    await expect(
      advanceMaintenance(database, uncertain, pending.pending!.id),
    ).rejects.toThrow("inactive");
    await database
      .update(schema.productionRuntimeMaintenance)
      .set({ grant: row!.grant })
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );

    await database
      .update(schema.productionRuntimeMaintenanceAttempts)
      .set({
        journal: { ...pending, leaseExpiresAt: new Date(0).toISOString() },
      })
      .where(eq(schema.productionRuntimeMaintenanceAttempts.id, uncertain.id));
    await expect(renewMaintenance(database, uncertain)).rejects.toThrow(
      "expired",
    );
    await recordMaintenanceExpiry(database, uncertain);
    const [saved] = await database
      .select()
      .from(schema.productionRuntimeMaintenanceAttempts)
      .where(eq(schema.productionRuntimeMaintenanceAttempts.id, uncertain.id));
    expect(saved!.journal.status).toBe("interrupted");
    expect(saved!.journal.pending).toEqual(pending.pending);
    await expect(
      claimMaintenance(database, deploymentId, revision),
    ).rejects.toThrow("unfinished");
  },
);
check(
  "grant authority survives logout but not account or project changes",
  async () => {
    const [row] = await database
      .select()
      .from(schema.productionRuntimeMaintenance)
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );
    const revision = row!.grant.revision;
    await database
      .delete(schema.session)
      .where(eq(schema.session.id, actor.sessionId));
    expect(
      (await loadMaintenanceAuthority(database, deploymentId, revision))
        .revision,
    ).toBe(revision);
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, actor.userId));
    await expect(
      loadMaintenanceAuthority(database, deploymentId, revision),
    ).rejects.toThrow("inactive");
    await database
      .update(schema.user)
      .set({ banned: false, accessRevision: crypto.randomUUID() })
      .where(eq(schema.user.id, actor.userId));
    await expect(
      loadMaintenanceAuthority(database, deploymentId, revision),
    ).rejects.toThrow("inactive");
    await database
      .update(schema.user)
      .set({ accessRevision: actor.revision })
      .where(eq(schema.user.id, actor.userId));
    await database
      .update(schema.projects)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    await expect(
      loadMaintenanceAuthority(database, deploymentId, revision),
    ).rejects.toThrow("inactive");
    await database
      .update(schema.projects)
      .set({ archivedAt: null, accessRevision: crypto.randomUUID() })
      .where(eq(schema.projects.id, projectId));
    await expect(
      loadMaintenanceAuthority(database, deploymentId, revision),
    ).rejects.toThrow("inactive");
    await database
      .update(schema.projects)
      .set({ accessRevision })
      .where(eq(schema.projects.id, projectId));
    await expect(
      loadMaintenanceAuthority(database, deploymentId, crypto.randomUUID()),
    ).rejects.toThrow("inactive");
    await database.insert(schema.session).values({
      id: actor.sessionId,
      userId: actor.userId,
      accessRevision: actor.revision,
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 600000),
    });
  },
);
check(
  "withdrawal remains possible with changed infrastructure; old receipts never re-enable it",
  async () => {
    const [row] = await database
      .select()
      .from(schema.productionRuntimeMaintenance)
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );
    const [action] = await database
      .select()
      .from(schema.productionRuntimeMaintenanceActions)
      .where(
        eq(schema.productionRuntimeMaintenanceActions.actorId, actor.userId),
      );
    await database
      .update(schema.productionRuntimeHosts)
      .set({ status: "failed" })
      .where(eq(schema.productionRuntimeHosts.id, hostId));
    const paused = await changeMaintenancePermission(
      database,
      actor,
      projectId,
      deploymentId,
      decision(row!.grant.revision, "paused"),
    );
    await expect(
      changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        decision(paused.grant.revision),
      ),
    ).rejects.toThrow();
    const initial = {
      requestId: action!.requestId,
      expectedAccessRevision: accessRevision,
      expectedGrantRevision: null,
      state: "enabled",
      confirmMaintenance: true,
    };
    expect(
      (
        await changeMaintenancePermission(
          database,
          actor,
          projectId,
          deploymentId,
          initial,
        )
      ).replayed,
    ).toBe(true);
    const [stillPaused] = await database
      .select()
      .from(schema.productionRuntimeMaintenance)
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );
    expect(stillPaused!.grant.state).toBe("paused");
    await database
      .update(schema.projects)
      .set({ archivedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    const revoked = await changeMaintenancePermission(
      database,
      actor,
      projectId,
      deploymentId,
      decision(paused.grant.revision, "revoked"),
    );
    expect(revoked.grant.state).toBe("revoked");
    await expect(
      changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        decision(revoked.grant.revision),
      ),
    ).rejects.toThrow("Revoked");
  },
);
check(
  "expired and suspended owner sessions cannot change or replay permission",
  async () => {
    const [row] = await database
      .select()
      .from(schema.productionRuntimeMaintenance)
      .where(
        eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId),
      );
    await database
      .update(schema.session)
      .set({ expiresAt: new Date(0) })
      .where(eq(schema.session.id, actor.sessionId));
    await expect(
      changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        decision(row!.grant.revision, "revoked"),
      ),
    ).rejects.toThrow("Sign in");
    await database
      .update(schema.session)
      .set({ expiresAt: new Date(Date.now() + 600000) })
      .where(eq(schema.session.id, actor.sessionId));
    await database
      .update(schema.user)
      .set({ banned: true })
      .where(eq(schema.user.id, actor.userId));
    await expect(
      changeMaintenancePermission(
        database,
        actor,
        projectId,
        deploymentId,
        decision(row!.grant.revision, "revoked"),
      ),
    ).rejects.toThrow("Sign in");
    expect(
      await database
        .select()
        .from(schema.productionRuntimeMaintenanceActions)
        .where(
          eq(schema.productionRuntimeMaintenanceActions.actorId, actor.userId),
        ),
    ).toHaveLength(3);
  },
);
