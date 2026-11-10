import { executeProductionResourceMigrations } from "../data/migrations";
import { readAppDatabaseManifest } from "@wrenly/sandbox/database-manifest";
import type { DatabaseClaim } from "../../database-store";
import { admitProductionDatabaseAction } from "../data/actions";
import { executeProductionResourceBackup } from "../data/backup";
import { runProjectProductionProvisionOnce } from "./worker";
import { executeProductionResourceCreation } from "./resource-worker";
/** Dedicated disposable control-store acceptance; SQL side effects are tested separately against native PostgreSQL. */
import { beforeAll, beforeEach, afterAll, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
import {
  admitProductionProvisionReview,
  claimProductionProvisionReview,
  loadProductionProvisionReview,
  finishProductionProvisionReview,
  resumeProductionProvision,
} from "./recovery-store";
import {
  attachProductionProjectResource,
  loadProductionResourceExecution,
  saveProductionResourceNetwork,
} from "./resource-store";
import {
  claimDatabaseAction,
  recordDatabaseEffect,
  renewDatabaseAction,
} from "../../database-store";
import { accessContext } from "../../../auth/access/access-context";
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
let productionCA: string | undefined;
const nativeAddress = process.env.WRENLY_TEST_PROJECT_CLUSTER_ADDRESS;
const nativeCluster = process.env.WRENLY_TEST_PROJECT_CLUSTER_ID;
const nativeCA = process.env.WRENLY_TEST_PROJECT_CLUSTER_CA;
const networks: string[] = [];
const nativeReadiness =
  url && nativeAddress && nativeCluster && nativeCA ? test : test.skip;
const target = {
  version: 1 as const,
  environment: "production" as const,
  host: "apps.internal.test",
  port: Number(process.env.WRENLY_TEST_PROJECT_CLUSTER_PORT ?? "5432"),
  database: "maintenance",
  sslmode: "verify-full" as const,
};
beforeAll(async () => {
  if (!url) return;
  if (nativeCA) productionCA = await readFile(nativeCA, "utf8");
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
    await database.delete(schema.appDatabaseMigrations);
    await database.delete(schema.appDatabaseBackups);
    await database.delete(schema.appDatabaseOperations);
    await database.delete(schema.appDatabases);
    await database.delete(schema.productionDatabaseProvisionReviews);
    await database.delete(schema.productionDatabaseProvisions);
    await database.delete(schema.productionDatabaseConnections);
  }
});
afterAll(async () => {
  for (const network of networks) {
    const child = Bun.spawn(["docker", "network", "rm", network], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await child.exited) !== 0)
      throw new Error("Disposable Production network cleanup failed");
  }
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
      ...(productionCA ? { certificateAuthority: productionCA } : {}),
    },
    directory,
  );
  const claim = await claimInstanceProductionConnection(database);
  if (!claim) throw new Error("Missing connection claim");
  await finishInstanceProductionConnection(database, claim, {
    status: "verified",
    inspection: {
      clusterId: nativeCluster ?? "123456789",
      database: "maintenance",
      setupRole: "postgres",
      serverVersion: 170000,
    },
    pinned: { target, addresses: [nativeAddress ?? "10.20.30.40"] },
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

check(
  "confirmed read-only recovery preserves history and resumes only remaining phases with the current session",
  async () => {
    const { project, input } = await fixture();
    const original = await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const oldClaim = await claimProjectProductionProvision(database);
    if (!oldClaim) throw new Error("Missing claim");
    await beginProjectProductionPhase(database, oldClaim, "roles", directory);
    await finishProjectProductionPhase(database, oldClaim, "roles", false);
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: project.accessRevision,
      confirmInspect: true,
    };
    const review = await admitProductionProvisionReview(
      database,
      principal,
      project.id,
      original.resourceId,
      request,
    );
    expect(
      (
        await admitProductionProvisionReview(
          database,
          principal,
          project.id,
          original.resourceId,
          request,
        )
      ).reviewId,
    ).toBe(review.reviewId);
    const inspection = await claimProductionProvisionReview(database);
    if (!inspection) throw new Error("Missing inspection");
    expect(
      (await loadProductionProvisionReview(database, inspection, directory))
        .phase,
    ).toBe("roles");
    await finishProductionProvisionReview(database, inspection, "confirmed");
    const [before] = await database
      .select()
      .from(schema.productionDatabaseProvisions)
      .where(eq(schema.productionDatabaseProvisions.id, original.resourceId));
    expect(before?.status).toBe("needs_review");
    const current = { ...principal, sessionId: crypto.randomUUID() };
    await database.insert(schema.session).values({
      id: current.sessionId,
      userId: current.userId,
      token: crypto.randomUUID(),
      accessRevision: current.revision,
      expiresAt: new Date(Date.now() + 600000),
    });
    const confirmation = {
      requestId: crypto.randomUUID(),
      expectedRevision: project.accessRevision,
      confirmContinue: true,
    };
    const continued = await resumeProductionProvision(
      database,
      current,
      project.id,
      review.reviewId,
      confirmation,
    );
    expect(continued.completedPhases).toEqual(["roles"]);
    expect(
      (
        await resumeProductionProvision(
          database,
          current,
          project.id,
          review.reviewId,
          confirmation,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      resumeProductionProvision(
        database,
        current,
        project.id,
        review.reviewId,
        { ...confirmation, requestId: crypto.randomUUID() },
      ),
    ).rejects.toThrow();
    const next = await claimProjectProductionProvision(database);
    if (!next) throw new Error("Missing resumed claim");
    expect(next.completedPhases).toEqual(["roles"]);
    expect(next.principal.sessionId).toBe(current.sessionId);
    await expect(
      beginProjectProductionPhase(database, next, "roles", directory),
    ).rejects.toThrow();
    await beginProjectProductionPhase(database, next, "database", directory);
    const [after] = await database
      .select()
      .from(schema.productionDatabaseProvisions)
      .where(eq(schema.productionDatabaseProvisions.id, original.resourceId));
    expect(after?.sessionId).toBe(principal.sessionId);
    expect(after?.executionPrincipal?.sessionId).toBe(current.sessionId);
    expect(after?.secrets).toEqual(before?.secrets);
  },
);
check(
  "absent-phase recovery permits explicit continuation without acknowledging SQL that did not run",
  async () => {
    const { project, input } = await fixture();
    const original = await admitProjectProductionProvision(
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
    const review = await admitProductionProvisionReview(
      database,
      principal,
      project.id,
      original.resourceId,
      {
        requestId: crypto.randomUUID(),
        expectedRevision: project.accessRevision,
        confirmInspect: true,
      },
    );
    const inspection = await claimProductionProvisionReview(database);
    if (!inspection) throw new Error("Missing inspection");
    await finishProductionProvisionReview(database, inspection, "absent");
    const resumed = await resumeProductionProvision(
      database,
      principal,
      project.id,
      review.reviewId,
      {
        requestId: crypto.randomUUID(),
        expectedRevision: project.accessRevision,
        confirmContinue: true,
      },
    );
    expect(resumed.completedPhases).toEqual([]);
    expect(resumed.status).toBe("queued");
    expect(await claimProductionProvisionReview(database)).toBeNull();
  },
);
check(
  "active claims and refused inspections cannot clear the creation blocker",
  async () => {
    const { project, input } = await fixture();
    const original = await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing claim");
    const request = {
      requestId: crypto.randomUUID(),
      expectedRevision: project.accessRevision,
      confirmInspect: true,
    };
    await expect(
      admitProductionProvisionReview(
        database,
        principal,
        project.id,
        original.resourceId,
        request,
      ),
    ).rejects.toThrow();
    await beginProjectProductionPhase(database, claim, "roles", directory);
    await finishProjectProductionPhase(database, claim, "roles", false);
    const review = await admitProductionProvisionReview(
      database,
      principal,
      project.id,
      original.resourceId,
      request,
    );
    const inspection = await claimProductionProvisionReview(database);
    if (!inspection) throw new Error("Missing inspection");
    await finishProductionProvisionReview(database, inspection, "review");
    await expect(
      resumeProductionProvision(
        database,
        principal,
        project.id,
        review.reviewId,
        {
          requestId: crypto.randomUUID(),
          expectedRevision: project.accessRevision,
          confirmContinue: true,
        },
      ),
    ).rejects.toThrow();
    const [saved] = await database
      .select()
      .from(schema.productionDatabaseProvisions)
      .where(eq(schema.productionDatabaseProvisions.id, original.resourceId));
    expect(saved?.status).toBe("needs_review");
    expect(saved?.effectPhase).toBe("roles");
  },
);
check(
  "a phase with no saved intent cannot be adopted as confirmed SQL",
  async () => {
    const { project, input } = await fixture();
    const original = await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing claim");
    await database
      .update(schema.productionDatabaseProvisions)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(schema.productionDatabaseProvisions.id, original.resourceId));
    const review = await admitProductionProvisionReview(
      database,
      principal,
      project.id,
      original.resourceId,
      {
        requestId: crypto.randomUUID(),
        expectedRevision: project.accessRevision,
        confirmInspect: true,
      },
    );
    const inspection = await claimProductionProvisionReview(database);
    if (!inspection) throw new Error("Missing inspection");
    const result = await finishProductionProvisionReview(
      database,
      inspection,
      "confirmed",
    );
    expect(result.status).toBe("refused");
    await expect(
      resumeProductionProvision(
        database,
        principal,
        project.id,
        review.reviewId,
        {
          requestId: crypto.randomUUID(),
          expectedRevision: project.accessRevision,
          confirmContinue: true,
        },
      ),
    ).rejects.toThrow();
  },
);

check(
  "an expired inspection report cannot authorize continuation",
  async () => {
    const { project, input } = await fixture();
    const original = await admitProjectProductionProvision(
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
    const review = await admitProductionProvisionReview(
      database,
      principal,
      project.id,
      original.resourceId,
      {
        requestId: crypto.randomUUID(),
        expectedRevision: project.accessRevision,
        confirmInspect: true,
      },
    );
    const inspection = await claimProductionProvisionReview(database);
    if (!inspection) throw new Error("Missing inspection");
    await finishProductionProvisionReview(database, inspection, "confirmed");
    await database
      .update(schema.productionDatabaseProvisionReviews)
      .set({ completedAt: new Date(0) })
      .where(eq(schema.productionDatabaseProvisionReviews.id, review.reviewId));
    await expect(
      resumeProductionProvision(
        database,
        principal,
        project.id,
        review.reviewId,
        {
          requestId: crypto.randomUUID(),
          expectedRevision: project.accessRevision,
          confirmContinue: true,
        },
      ),
    ).rejects.toThrow();
    const [saved] = await database
      .select()
      .from(schema.productionDatabaseProvisions)
      .where(eq(schema.productionDatabaseProvisions.id, original.resourceId));
    expect(saved?.status).toBe("needs_review");
    expect(saved?.effectPhase).toBe("roles");
  },
);

check(
  "SQL completion hands off once to a pending Production resource and only its provider can claim it",
  async () => {
    const { project, input } = await fixture();
    const created = await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    await expect(
      attachProductionProjectResource({
        database,
        principal,
        projectId: project.id,
        provisionId: created.resourceId,
        directory,
      }),
    ).rejects.toThrow();
    const claim = await claimProjectProductionProvision(database);
    if (!claim) throw new Error("Missing SQL claim");
    let originalSecret = "";
    for (const phase of PRODUCTION_PROVISION_PHASES) {
      const saved = await beginProjectProductionPhase(
        database,
        claim,
        phase,
        directory,
      );
      originalSecret = saved.credentials.runtime.password;
      await finishProjectProductionPhase(database, claim, phase, true);
    }
    const receipt = await attachProductionProjectResource({
      database,
      principal,
      projectId: project.id,
      provisionId: created.resourceId,
      directory,
    });
    expect(
      (
        await attachProductionProjectResource({
          database,
          principal,
          projectId: project.id,
          provisionId: created.resourceId,
          directory,
        })
      ).operationId,
    ).toBe(receipt.operationId);
    const [resource] = await database
      .select()
      .from(schema.appDatabases)
      .where(eq(schema.appDatabases.id, receipt.resourceId));
    expect(resource?.status).toBe("provisioning");
    expect(resource?.runtimeIdentity).toBeNull();
    expect(JSON.stringify(resource)).not.toContain(originalSecret);
    await accessContext.run({ principal }, async () => {
      expect(await claimDatabaseAction(database)).toBeNull();
      const executionClaim = await claimDatabaseAction(
        database,
        "postgres-cluster",
      );
      if (!executionClaim) throw new Error("Missing Production resource claim");
      const execution = await loadProductionResourceExecution(
        database,
        executionClaim,
        directory,
      );
      expect(execution.credentials.runtime.password).toBe(originalSecret);
      expect(execution.server.clusterId).toBe(nativeCluster ?? "123456789");
      await expect(
        saveProductionResourceNetwork(database, executionClaim, "a".repeat(64)),
      ).rejects.toThrow();
      await recordDatabaseEffect(database, executionClaim, {
        kind: "create-network",
        id: `wrenly-production-network-${receipt.resourceId}`,
      });
      await saveProductionResourceNetwork(
        database,
        executionClaim,
        "a".repeat(64),
      );
      const again = await loadProductionResourceExecution(
        database,
        executionClaim,
        directory,
      );
      expect(again.resource.providerIdentity?.networkId).toBe("a".repeat(64));
      expect(again.resource.status).toBe("provisioning");
    });
  },
);

nativeReadiness(
  "actual private TLS SQL creation becomes ready only after isolated reader acceptance",
  async () => {
    const { project, input } = await fixture();
    const created = await admitProjectProductionProvision(
      database,
      principal,
      project.id,
      input,
      directory,
    );
    const signal = AbortSignal.timeout(160_000);
    const lookup = async (): Promise<
      Array<{ address: string; family: number }>
    > => [{ address: nativeAddress!, family: 4 }];
    const result = await runProjectProductionProvisionOnce({
      database,
      directory,
      controlDatabaseUrl: url!,
      signal,
      lookup,
    });
    expect(result?.status).toBe("created");
    await attachProductionProjectResource({
      database,
      principal,
      projectId: project.id,
      provisionId: created.resourceId,
      directory,
    });
    const claim = await accessContext.run({ principal }, () =>
      claimDatabaseAction(database, "postgres-cluster"),
    );
    if (!claim) throw new Error("Missing Production readiness claim");
    try {
      expect(
        await executeProductionResourceCreation({
          database,
          claim,
          directory,
          controlDatabaseUrl: url!,
          signal,
          lookup,
        }),
      ).toBe("success");
      const [resource] = await database
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.id, created.resourceId));
      expect(resource?.status).toBe("ready");
      expect(resource?.runtimeIdentity).toBeNull();
      expect(resource?.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
      const [operation] = await database
        .select()
        .from(schema.appDatabaseOperations)
        .where(eq(schema.appDatabaseOperations.id, claim.id));
      expect(operation?.status).toBe("success");
      expect(operation?.effect).toBeNull();
      expect(operation?.cleanupEffect).toBeNull();
      const currentPrincipal = { ...principal, sessionId: crypto.randomUUID() };
      await database.insert(schema.session).values({
        id: currentPrincipal.sessionId,
        userId: principal.userId,
        token: crypto.randomUUID(),
        accessRevision: principal.revision,
        expiresAt: new Date(Date.now() + 600000),
      });
      await database
        .update(schema.session)
        .set({ accessRevision: crypto.randomUUID() })
        .where(eq(schema.session.id, principal.sessionId));
      const action = {
        requestId: crypto.randomUUID(),
        environment: "production",
        kind: "backup",
        expectedRevision: resource!.revision,
      };
      const admitted = await admitProductionDatabaseAction(
        database,
        currentPrincipal,
        project.id,
        action,
      );
      expect(
        (
          await admitProductionDatabaseAction(
            database,
            currentPrincipal,
            project.id,
            action,
          )
        ).operationId,
      ).toBe(admitted.operationId);
      expect(await claimDatabaseAction(database)).toBeNull();
      const backupClaim = await accessContext.run({ principal }, () =>
        claimDatabaseAction(database, "postgres-cluster"),
      );
      if (!backupClaim) throw new Error("Missing Production backup claim");
      expect(
        await withRenewedClaim(backupClaim, () =>
          executeProductionResourceBackup({
            database,
            claim: backupClaim,
            directory,
            controlDatabaseUrl: url!,
            signal,
            lookup,
          }),
        ),
      ).toBe("success");
      const [backup] = await database
        .select()
        .from(schema.appDatabaseBackups)
        .where(eq(schema.appDatabaseBackups.operationId, backupClaim.id));
      expect(backup?.verifiedAt).toBeInstanceOf(Date);
      expect(backup?.schemaDigest).toBe(resource?.schemaDigest);
      expect(backup?.sha256).toMatch(/^[a-f0-9]{64}$/);
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
          content:
            "CREATE TABLE public.booking_requests (id serial PRIMARY KEY, customer_name text NOT NULL);",
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
                when: 1700000000000,
                tag: "0000_initial",
                breakpoints: true,
              },
            ],
          }),
        },
      ];
      const manifest = readAppDatabaseManifest(files, "nextjs");
      if (!manifest || !backup)
        throw new Error("Missing reviewed fixture migration");
      const buildId = crypto.randomUUID();
      await database
        .insert(schema.builds)
        .values({
          id: buildId,
          projectId: project.id,
          prompt: "Fixture booking schema",
          stack: "nextjs",
          status: "success",
          files,
        });
      const [latest] = await database
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.id, resource!.id));
      await admitProductionDatabaseAction(
        database,
        currentPrincipal,
        project.id,
        {
          requestId: crypto.randomUUID(),
          environment: "production",
          kind: "migrate",
          expectedRevision: latest!.revision,
          buildId,
          backupId: backup.id,
          migrationDigest: manifest.digest,
          confirmChanges: true,
        },
      );
      const migrationClaim = await claimDatabaseAction(
        database,
        "postgres-cluster",
      );
      if (!migrationClaim)
        throw new Error("Missing Production migration claim");
      expect(
        await withRenewedClaim(migrationClaim, () =>
          executeProductionResourceMigrations({
            database,
            claim: migrationClaim,
            directory,
            controlDatabaseUrl: url!,
            signal,
            lookup,
          }),
        ),
      ).toBe("success");
      const [migration] = await database
        .select()
        .from(schema.appDatabaseMigrations)
        .where(eq(schema.appDatabaseMigrations.operationId, migrationClaim.id));
      expect(migration?.completedAt).toBeInstanceOf(Date);
      const [migrated] = await database
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.id, resource!.id));
      expect(migrated?.schemaDigest).toBe(migration?.rehearsedSchemaDigest);
      expect(migrated?.schemaDigest).not.toBe(backup.schemaDigest);
    } finally {
      const [resource] = await database
        .select()
        .from(schema.appDatabases)
        .where(eq(schema.appDatabases.id, created.resourceId));
      if (resource?.providerIdentity?.networkId)
        networks.push(resource.providerIdentity.networkId);
    }
  },
  180_000,
);

/** Production renews claims through its worker; direct native acceptance must do the same during restore rehearsal. */
async function withRenewedClaim<T>(
  claim: DatabaseClaim,
  run: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  let failure: unknown;
  const timer = setInterval(() => {
    if (!stopped)
      void renewDatabaseAction(database, claim).catch((error) => {
        failure = error;
      });
  }, 5_000);
  try {
    const result = await run();
    if (failure) throw failure;
    return result;
  } finally {
    stopped = true;
    clearInterval(timer);
  }
}
