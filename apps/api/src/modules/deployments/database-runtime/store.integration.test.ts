import { loadProductionPublishingRuntimeSecrets } from "./secrets";
import {
  loadDatabaseKey,
  encryptDatabaseSecret,
} from "../../databases/database-secrets";
import { sealRuntimeHostCredential } from "../../databases/production-targets/deployment-hosts/credentials";
import { sealProductionConnection } from "../../databases/production-targets/instance/credentials";
import { createProductionProjectCredentials } from "@wrenly/db/production-project-credentials";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { z } from "zod";
import { accessContext } from "../../auth/access/access-context";
import { admitDeployment } from "../persistence/deployment-store";
import { finishDeployment } from "../persistence/deployment-store";
import { loadInterruptedDeployment } from "../persistence/reconciliation-store";
import { freezeProductionPublishingBinding } from "./binding";
import { lockDatabaseQueues } from "../../databases/database-store";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import { validateDeploymentSource } from "../policy/source-policy";
/** A dedicated disposable database only; never run against an existing Wrenly installation. */
import { beforeAll, afterAll, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import * as schema from "@wrenly/db/schema";
import {
  beginProductionRuntimeEffect,
  acknowledgeProductionRuntimeEffect,
  loadProductionPublishingRuntime,
} from "./store";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingJournal,
  ProductionPublishingReceipt,
} from "@wrenly/db/production-publishing-contract";
import type { ProductionPublishingBinding } from "@wrenly/db/production-publishing-contract";
const url = process.env.WRENLY_TEST_PRODUCTION_PUBLISHING_URL;
if (url) {
  const parsed = new URL(url);
  if (
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/wrenly_production_publishing_test"
  )
    throw new Error("Use the dedicated disposable publishing test database.");
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
const claim = { deploymentId, token };
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
let directory = "";
beforeAll(async () => {
  if (!url) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-publishing-secret-test-"));
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
  if (directory) await rm(directory, { recursive: true, force: true });
});
check(
  "persisted intent survives failed acknowledgements and prevents remote replay",
  async () => {
    expect(
      (await loadProductionPublishingRuntime(database, claim)).journal.pending,
    ).toBeNull();
    const effect = await beginProductionRuntimeEffect(database, claim);
    expect(effect.step).toBe("http-volume");
    await expect(beginProductionRuntimeEffect(database, claim)).rejects.toThrow(
      "review",
    );
    const receipt = {
      effect,
      fact: {
        step: "http-volume",
        name: `wrenly-deployment-http-${deploymentId}`,
        createdAt: new Date().toISOString(),
      },
      completedAt: new Date().toISOString(),
    };
    await expect(
      acknowledgeProductionRuntimeEffect(
        database,
        { ...claim, token: crypto.randomUUID() },
        receipt,
      ),
    ).rejects.toThrow();
    expect(
      (await loadProductionPublishingRuntime(database, claim)).journal.pending
        ?.id,
    ).toBe(effect.id);
    await acknowledgeProductionRuntimeEffect(database, claim, receipt);
    expect(
      (await loadProductionPublishingRuntime(database, claim)).journal
        .completed,
    ).toHaveLength(1);
    await expect(
      acknowledgeProductionRuntimeEffect(database, claim, receipt),
    ).rejects.toThrow();
  },
);
check(
  "publishing binding requires the exact successful source and applied Production migration set",
  async () => {
    const files = [
      {
        path: "wrenly.app.json",
        content: JSON.stringify({
          version: 1,
          database: {
            engine: "postgresql",
            adapter: "drizzle-postgres",
            migrations: ["drizzle/0000_initial.sql"],
          },
        }),
      },
      {
        path: "drizzle/0000_initial.sql",
        content: "CREATE TABLE notes (id integer PRIMARY KEY);",
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
              tag: "0000_initial",
              when: 1,
              breakpoints: true,
            },
          ],
        }),
      },
    ];
    const source = validateDeploymentSource(files),
      manifest = readAppDatabaseManifest(files, "nextjs")!;
    await database
      .update(schema.builds)
      .set({ files })
      .where(eq(schema.builds.id, buildId));
    await database
      .update(schema.productionRuntimeHosts)
      .set({ pinnedAddresses: ["10.0.0.1"] })
      .where(eq(schema.productionRuntimeHosts.id, hostId));
    const input = {
      deploymentId,
      projectId,
      buildId,
      sourceSha256: source.sha256,
      files,
      stack: "nextjs" as const,
      serverId: "fixture-server",
      principal: actor,
    };
    const freeze = () =>
      database.transaction(async (tx) => {
        await lockDatabaseQueues(tx);
        return freezeProductionPublishingBinding(tx, input);
      });
    await expect(freeze()).rejects.toThrow("applied migrations");
    const operationId = crypto.randomUUID(),
      now = new Date();
    await database.insert(schema.appDatabaseOperations).values({
      id: operationId,
      databaseId: resourceId,
      projectId,
      actorId: actor.userId,
      requestId: crypto.randomUUID(),
      requestIdentity: "fixture-applied",
      kind: "migrate",
      status: "success",
      buildId,
      migrationDigest: manifest.digest,
      completedAt: now,
    });
    await database.insert(schema.appDatabaseMigrations).values({
      databaseId: resourceId,
      operationId,
      buildId,
      digest: manifest.digest,
      manifest: manifest.files,
      rehearsedSchemaDigest: binding.schemaDigest,
      completedAt: now,
    });
    const frozen = await freeze();
    expect(frozen.resourceId).toBe(resourceId);
    expect(frozen.migrationDigest).toBe(manifest.digest);
    expect(frozen.sourceSha256).toBe(source.sha256);
    // Admission must save the exact proof atomically; the original executor fixture is restored afterwards.
    await database
      .update(schema.deployments)
      .set({ status: "success" })
      .where(eq(schema.deployments.id, deploymentId));
    const request = {
      projectId,
      userId: actor.userId,
      buildId,
      idempotencyKey: crypto.randomUUID(),
      allowProductionDatabase: true,
      target: {
        gitInstanceUrl: "http://gitea.fixture",
        repositoryOwner: "fixture",
        coolifyInstanceUrl: "http://coolify.fixture",
        coolifyProjectUuid: "fixture",
        coolifyServerUuid: "fixture-server",
        coolifyEnvironmentName: "production",
      },
    };
    let admittedId: string | undefined;
    try {
      await expect(admitDeployment(database, request)).rejects.toThrow(
        "Production",
      );
      await accessContext.run({ principal: actor }, async () => {
        await expect(
          admitDeployment(database, {
            ...request,
            allowProductionDatabase: false,
          }),
        ).rejects.toThrow("Production");
        const admitted = await admitDeployment(database, request);
        admittedId = admitted.deploymentId;
        const [saved] = await database
          .select()
          .from(schema.deployments)
          .where(eq(schema.deployments.id, admittedId));
        expect(saved?.productionDatabaseBinding?.resourceId).toBe(resourceId);
        expect(saved?.productionDatabaseBinding?.deploymentId).toBe(admittedId);
        expect(saved?.productionDatabaseBinding?.sourceSha256).toBe(
          source.sha256,
        );
        expect(saved?.productionRuntimeJournal).toEqual({
          version: 1,
          pending: null,
          completed: [],
        });
        expect(await admitDeployment(database, request)).toEqual({
          deploymentId: admittedId,
          replayed: true,
        });
      });
    } finally {
      if (admittedId)
        await database
          .delete(schema.deployments)
          .where(eq(schema.deployments.id, admittedId));
      await database
        .update(schema.deployments)
        .set({ status: "preparing" })
        .where(eq(schema.deployments.id, deploymentId));
    }

    await expect(
      database.transaction(async (tx) => {
        await lockDatabaseQueues(tx);
        return freezeProductionPublishingBinding(tx, {
          ...input,
          sourceSha256: "f".repeat(64),
        });
      }),
    ).rejects.toThrow();
  },
);
check(
  "runtime evidence cannot be bypassed by generic completion or stateless reconciliation",
  async () => {
    const id = crypto.randomUUID(),
      lease = crypto.randomUUID();
    await database.insert(schema.deployments).values({
      id,
      projectId,
      buildId,
      userId: actor.userId,
      idempotencyKey: crypto.randomUUID(),
      requestIdentity: "fixture-finalization",
      stack: "nextjs",
      files: [],
      sourceSha256: binding.sourceSha256,
      status: "verifying",
      claimToken: lease,
      leaseExpiresAt: new Date(Date.now() + 600000),
      artifactImageId: `sha256:${"e".repeat(64)}`,
      registryDigest: `sha256:${"f".repeat(64)}`,
      remoteDeploymentUuid: "fixture-job",
      productionDatabaseBinding: { ...binding, deploymentId: id },
      productionRuntimeJournal: { version: 1, pending: null, completed: [] },
    });
    await expect(
      finishDeployment(
        database,
        { deploymentId: id, token: lease },
        { status: "success", url: "https://app.example.test/" },
      ),
    ).rejects.toThrow("runtime and route evidence");
    await finishDeployment(
      database,
      { deploymentId: id, token: lease },
      { status: "failed", code: "PROVIDER_FAILURE" },
    );
    const [saved] = await database
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id));
    expect(saved?.status).toBe("interrupted");
    expect(saved?.productionDatabaseBinding?.deploymentId).toBe(id);
    await database
      .update(schema.deployments)
      .set({ updatedAt: new Date(Date.now() - 70000) })
      .where(eq(schema.deployments.id, id));
    await expect(loadInterruptedDeployment(database, id)).rejects.toThrow(
      "stateless reconciliation",
    );
  },
);
check(
  "complete Production route evidence finishes without a stateless deployment job",
  async () => {
    const id = crypto.randomUUID(),
      lease = crypto.randomUUID(),
      savedBinding = { ...binding, deploymentId: id };
    const image = `sha256:${"e".repeat(64)}`;
    const facts: z.infer<typeof ProductionPublishingReceipt>["fact"][] = [
      {
        step: "http-volume",
        name: `wrenly-deployment-http-${id}`,
        createdAt: new Date().toISOString(),
      },
      {
        step: "database-volume",
        name: `wrenly-deployment-db-${id}`,
        createdAt: new Date().toISOString(),
      },
      { step: "broker-network", networkId: "1".repeat(64) },
      {
        step: "broker-start",
        networkId: "1".repeat(64),
        containerId: "2".repeat(64),
        imageId: image,
        volumeName: `wrenly-deployment-db-${id}`,
      },
      {
        step: "service-create",
        serviceId: "fixture-service",
        compositionSha256: "3".repeat(64),
        appImageId: image,
        appRegistryDigest: image,
        ingressRegistryDigest: `sha256:${"4".repeat(64)}`,
      },
      { step: "service-start", serviceId: "fixture-service" },
      {
        step: "application-start",
        containerId: "5".repeat(64),
        imageId: image,
      },
      {
        step: "route-verify",
        url: "https://production.example.test/",
        sourceSha256: savedBinding.sourceSha256,
      },
    ];
    let journal: ProductionPublishingJournal = {
      version: 1,
      completed: [],
      pending: null,
    };
    for (const fact of facts) {
      journal = beginProductionPublishingEffect(
        savedBinding,
        journal,
        lease,
        new Date(),
      );
      if (!journal.pending) throw new Error("Missing fixture intent");
      journal = acknowledgeProductionPublishingEffect(
        savedBinding,
        journal,
        {
          effect: journal.pending,
          fact,
          completedAt: new Date().toISOString(),
        },
        lease,
      );
    }
    await database
      .insert(schema.deployments)
      .values({
        id,
        projectId,
        buildId,
        userId: actor.userId,
        idempotencyKey: crypto.randomUUID(),
        requestIdentity: "fixture-complete-production",
        stack: "nextjs",
        files: [],
        sourceSha256: savedBinding.sourceSha256,
        status: "verifying",
        claimToken: lease,
        leaseExpiresAt: new Date(Date.now() + 600000),
        artifactImageId: image,
        registryDigest: image,
        productionDatabaseBinding: savedBinding,
        productionRuntimeJournal: journal,
      });
    await expect(
      finishDeployment(
        database,
        { deploymentId: id, token: lease },
        { status: "success", url: "https://foreign.example.test/" },
      ),
    ).rejects.toThrow("route evidence");
    await finishDeployment(
      database,
      { deploymentId: id, token: lease },
      { status: "success", url: "https://production.example.test/" },
    );
    const [row] = await database
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, id));
    expect(row?.status).toBe("success");
    expect(row?.remoteDeploymentUuid).toBeNull();
  },
);
check(
  "runtime secret selection never returns management, migration or reader passwords",
  async () => {
    const [databaseKey, hostKey, instanceKey] = await Promise.all([
      loadDatabaseKey(join(directory, "database-keys"), false),
      loadDatabaseKey(join(directory, "production-host-keys"), false),
      loadDatabaseKey(join(directory, "production-instance-keys"), false),
    ]);
    const credentials = createProductionProjectCredentials(resourceId);
    await database
      .update(schema.appDatabases)
      .set({
        secrets: encryptDatabaseSecret(
          JSON.stringify(credentials),
          databaseKey,
          `${resourceId}:production`,
        ),
      })
      .where(eq(schema.appDatabases.id, resourceId));
    const [host] = await database
      .select()
      .from(schema.productionRuntimeHosts)
      .where(eq(schema.productionRuntimeHosts.id, hostId));
    const [server] = await database
      .select()
      .from(schema.productionDatabaseConnections)
      .where(eq(schema.productionDatabaseConnections.id, connectionId));
    if (!host || !server) throw new Error("Missing fixture setup.");
    const privateKey =
      "-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only\n-----END OPENSSH PRIVATE KEY-----\n";
    const hostSecret = sealRuntimeHostCredential(
      {
        requestId: host.requestId,
        expectedConnectionId: null,
        confirmTarget: true,
        serverId: host.serverId,
        target: host.target,
        privateKey,
      },
      host,
      hostKey,
    );
    const managementPassword = "fixture-management-only";
    const serverSecret = sealProductionConnection(
      {
        requestId: server.requestId,
        expectedConnectionId: null,
        confirmTarget: true,
        target: server.target,
        credential: { user: "postgres", password: managementPassword },
      },
      server,
      instanceKey,
    );
    await database
      .update(schema.productionRuntimeHosts)
      .set({ secret: hostSecret })
      .where(eq(schema.productionRuntimeHosts.id, hostId));
    await database
      .update(schema.productionDatabaseConnections)
      .set({ secret: serverSecret, pinnedAddresses: ["10.0.0.1"] })
      .where(eq(schema.productionDatabaseConnections.id, connectionId));
    const result = await loadProductionPublishingRuntimeSecrets({
      database,
      claim,
      directory,
      deploymentEncryptionKey: "d".repeat(64),
    });
    expect(result.database.runtimeRole).toEqual(credentials.runtime);
    expect(result.host.privateKey).toBe(privateKey);
    expect(result.appKey).toBeNull();
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      credentials.migrator.password,
      credentials.reader.password,
      managementPassword,
    ])
      expect(serialized).not.toContain(forbidden);
    await expect(
      loadProductionPublishingRuntimeSecrets({
        database,
        claim: { ...claim, token: crypto.randomUUID() },
        directory,
        deploymentEncryptionKey: "d".repeat(64),
      }),
    ).rejects.toThrow("could not be authenticated");
  },
);
check(
  "changed resource schema, host or owner session refuses the next effect",
  async () => {
    await database
      .update(schema.appDatabases)
      .set({ schemaDigest: "f".repeat(64) })
      .where(eq(schema.appDatabases.id, resourceId));
    await expect(beginProductionRuntimeEffect(database, claim)).rejects.toThrow(
      "database changed",
    );
    await database
      .update(schema.appDatabases)
      .set({ schemaDigest: binding.schemaDigest })
      .where(eq(schema.appDatabases.id, resourceId));
    await database
      .update(schema.productionRuntimeHosts)
      .set({ status: "needs_review" })
      .where(eq(schema.productionRuntimeHosts.id, hostId));
    await expect(beginProductionRuntimeEffect(database, claim)).rejects.toThrow(
      "placement changed",
    );
    await database
      .update(schema.productionRuntimeHosts)
      .set({ status: "verified" })
      .where(eq(schema.productionRuntimeHosts.id, hostId));
    await database
      .delete(schema.session)
      .where(eq(schema.session.id, actor.sessionId));
    await expect(
      beginProductionRuntimeEffect(database, claim),
    ).rejects.toThrow();
  },
);
