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
import {
  admitProductionProvisionReview,
  claimProductionProvisionReview,
  loadProductionProvisionReview,
  finishProductionProvisionReview,
  resumeProductionProvision,
} from "./recovery-store";
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
    await database.delete(schema.productionDatabaseProvisionReviews);
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
