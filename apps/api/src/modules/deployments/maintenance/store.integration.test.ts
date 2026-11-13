import { runOwnerRuntimeControl, readOwnerRuntimeControl } from "./owner-control";
import { parseApiEnvironment } from "../../../config/api-environment";
import { productionMaintenanceConfiguration } from "./production";
import { readMaintenanceOwnerState } from "./owner-state";
import {
  hasMemberDatabaseWork,
  hasUnfinishedMaintenance,
} from "../../databases/database-activity";
import { runMaintenanceClaim } from "./worker";
import { loadMaintenanceClaim } from "./claims";
import { hasDatabaseWork } from "../../databases/database-store";
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
      artifactImageId: image,
      registryRepository: "registry.fixture/wrenly/app",
      registryDigest: image,
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
    const ownerView = await readMaintenanceOwnerState({
      database,
      actor,
      projectId,
      deploymentId,
    });
    expect(ownerView).toEqual({
      accessRevision,
      grantRevision: saved.grant.revision,
      state: "enabled",
      attempt: null,
    });
    const receipt = await readMaintenanceOwnerState({
      database,
      actor,
      projectId,
      deploymentId,
      requestId: input.requestId,
    });
    expect(receipt).toEqual({
      requestId: input.requestId,
      grantRevision: saved.grant.revision,
      state: "enabled",
      replayed: true,
    });
    expect(JSON.stringify(ownerView)).not.toContain("claimToken");
    await expect(
      readMaintenanceOwnerState({
        database,
        actor: { ...actor, userId: crypto.randomUUID() },
        projectId,
        deploymentId,
      }),
    ).rejects.toThrow();
    expect(
      await readMaintenanceOwnerState({
        database,
        actor,
        projectId,
        deploymentId,
        requestId: crypto.randomUUID(),
      }),
    ).toBeNull();
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
    const environment = parseApiEnvironment({
      WRENLY_DATABASE_URL: "postgresql://fixture:fixture@127.0.0.1:1/fixture",
      WRENLY_AUTH_SECRET: "a".repeat(64),
      WRENLY_APP_URL: "http://localhost:3002",
      WRENLY_WEB_URL: "http://localhost:3000",
      WRENLY_COOLIFY_API_URL: "http://coolify.fixture/api/v1",
      WRENLY_COOLIFY_API_KEY: "fixture-only",
      WRENLY_COOLIFY_SERVER_UUID: "fixture-server",
      WRENLY_COOLIFY_PROJECT_UUID: "fixture",
      WRENLY_COOLIFY_ENVIRONMENT: "production",
      WRENLY_DEPLOY_ENCRYPTION_KEY: "ab".repeat(32),
      WRENLY_PRODUCTION_BROKER_IMAGE_ID: "sha256:" + "d".repeat(64),
      WRENLY_PRODUCTION_INGRESS_IMAGE_ID: "sha256:" + "d".repeat(64),
      WRENLY_PRODUCTION_INGRESS_IMAGE:
        "registry.fixture/wrenly/ingress@sha256:" + "d".repeat(64),
    });
    expect(
      (await productionMaintenanceConfiguration(database, environment, claim))
        .images.appImage,
    ).toBe("registry.fixture/wrenly/app@sha256:" + "d".repeat(64));
    await expect(
      productionMaintenanceConfiguration(
        database,
        { ...environment, WRENLY_COOLIFY_SERVER_UUID: "another-server" },
        claim,
      ),
    ).rejects.toThrow("changed");
    await expect(
      productionMaintenanceConfiguration(
        database,
        {
          ...environment,
          WRENLY_PRODUCTION_BROKER_IMAGE_ID: "sha256:" + "a".repeat(64),
        },
        claim,
      ),
    ).rejects.toThrow("changed");

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
    const workerClaim = await claimMaintenance(
      database,
      deploymentId,
      revision,
    );
    const performed: string[] = [];
    await runMaintenanceClaim({
      database,
      claim: workerClaim,
      signal: new AbortController().signal,
      services: (assertHeld) => ({
        load: () => loadMaintenanceClaim(database, workerClaim),
        begin: () => advanceMaintenance(database, workerClaim),
        acknowledge: (id) => advanceMaintenance(database, workerClaim, id),
        assertHeld,
        perform: async ({ effect }) => {
          performed.push(effect.step);
        },
      }),
    });
    expect(performed).toEqual([
      "broker-start",
      "application-start",
      "route-verify",
    ]);
    await expect(
      claimMaintenance(database, deploymentId, revision, 60000),
    ).rejects.toThrow("recently");

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
    expect(await hasDatabaseWork(database, projectId)).toBe(true);
    expect(await hasMemberDatabaseWork(database, actor.userId)).toBe(true);
    expect(await hasMemberDatabaseWork(database, crypto.randomUUID())).toBe(
      false,
    );
    expect(await hasUnfinishedMaintenance(database)).toBe(true);
    await expect(
      claimMaintenance(database, deploymentId, revision),
    ).rejects.toThrow("unfinished");
    // Only this test's interrupted fixture is removed after proving the lifecycle fence.
    await database
      .delete(schema.productionRuntimeMaintenanceAttempts)
      .where(eq(schema.productionRuntimeMaintenanceAttempts.id, uncertain.id));
  },
  20000,
);
check("owner Stop pauses permission atomically and inspection reconciles unknown attempts without replay", async () => {
  const [saved] = await database.select().from(schema.productionRuntimeMaintenance).where(eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId));
  const grant = saved!.grant;
  const originalClaim = await claimMaintenance(database, deploymentId, grant.revision);
  const originalIntent = await advanceMaintenance(database, originalClaim);
  await database.update(schema.productionRuntimeMaintenanceAttempts).set({ journal: { ...originalIntent, status: "interrupted", leaseExpiresAt: new Date(0).toISOString() } }).where(eq(schema.productionRuntimeMaintenanceAttempts.id, originalClaim.id));
  const calls: string[] = [];
  const action = { requestId: crypto.randomUUID(), expectedAccessRevision: accessRevision, expectedGrantRevision: grant.revision, kind: "stop", confirmRuntimeControl: true };
  const services = { perform: async (context: Parameters<Parameters<typeof runOwnerRuntimeControl>[0]["services"]["perform"]>[0]) => {
    await context.assertHeld();
    const [permission] = await database.select().from(schema.productionRuntimeMaintenance).where(eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId));
    expect(permission!.grant.state).toBe("paused"); calls.push(context.effect.step);
  } };
  await expect(runOwnerRuntimeControl({ database, actor: { ...actor, userId: crypto.randomUUID() }, projectId, deploymentId, action, services })).rejects.toThrow();
  expect(calls).toEqual([]);
  const result = await runOwnerRuntimeControl({ database, actor, projectId, deploymentId, action, services });
  expect(result.status).toBe("success"); expect(calls).toEqual(["application-stop", "broker-stop", "verify-stopped"]);
  expect(await runOwnerRuntimeControl({ database, actor, projectId, deploymentId, action, services })).toEqual({ ...result, replayed: true });
  expect(calls).toHaveLength(3);
  expect((await readOwnerRuntimeControl({ database, actor, projectId, deploymentId, requestId: action.requestId }))?.status).toBe("success");
  const [old] = await database.select().from(schema.productionRuntimeMaintenanceAttempts).where(eq(schema.productionRuntimeMaintenanceAttempts.id, originalClaim.id));
  expect(old!.journal.status).toBe("reconciled"); expect(old!.journal.pending).toEqual(originalIntent.pending); expect(old!.journal.resolution?.outcome).toBe("stopped");
  expect(await hasDatabaseWork(database, projectId)).toBe(false);
  // A publication with maintenance never enabled must still have an explicit safe Stop.
  await database.delete(schema.productionRuntimeMaintenance).where(eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId));
  const withoutPermission = await runOwnerRuntimeControl({ database, actor, projectId, deploymentId,
    action: { ...action, requestId: crypto.randomUUID(), expectedGrantRevision: null }, services });
  expect(withoutPermission.status).toBe("success");
  const [paused] = await database.select().from(schema.productionRuntimeMaintenance).where(eq(schema.productionRuntimeMaintenance.deploymentId, deploymentId));
  await expect(claimMaintenance(database, deploymentId, paused!.grant.revision)).rejects.toThrow("inactive");
  const failed = { ...action, requestId: crypto.randomUUID(), expectedGrantRevision: paused!.grant.revision, kind: "inspect" };
  let attempts = 0;
  const lost = { perform: async () => { attempts++; throw new Error("lost host inspection reply"); } };
  await expect(runOwnerRuntimeControl({ database, actor, projectId, deploymentId, action: failed, services: lost })).rejects.toThrow("could not be confirmed");
  expect((await readOwnerRuntimeControl({ database, actor, projectId, deploymentId, requestId: failed.requestId }))?.status).toBe("interrupted");
  expect((await runOwnerRuntimeControl({ database, actor, projectId, deploymentId, action: failed, services: lost })).replayed).toBe(true);
  expect(attempts).toBe(1); expect(await hasDatabaseWork(database, projectId)).toBe(true);
  const inspectCalls: string[] = [];
  const inspected = await runOwnerRuntimeControl({ database, actor, projectId, deploymentId,
    action: { ...failed, requestId: crypto.randomUUID() }, services: { perform: async context => { await context.assertHeld(); inspectCalls.push(context.effect.step); } } });
  expect(inspected.status).toBe("success"); expect(inspectCalls).toEqual(["broker-inspect", "application-inspect", "route-inspect"]);
  expect(await hasDatabaseWork(database, projectId)).toBe(false);
  const [source] = await database.select().from(schema.productionRuntimeMaintenanceAttempts).where(eq(schema.productionRuntimeMaintenanceAttempts.id, failed.requestId));
  expect(source!.journal.status).toBe("reconciled"); expect(source!.journal.pending?.step).toBe("broker-inspect");
  // Restore this fixture's permission for the following independent authority tests.
  await changeMaintenancePermission(database, actor, projectId, deploymentId, { requestId: crypto.randomUUID(), expectedAccessRevision: accessRevision,
    expectedGrantRevision: paused!.grant.revision, state: "enabled", confirmMaintenance: true });
}, 30000);

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
    ).toHaveLength(4);
  },
);
