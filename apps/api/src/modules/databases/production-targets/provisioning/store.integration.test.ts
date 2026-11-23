/** Opt-in disposable control DB acceptance for the real provider journal and worker. */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as schema from "@wrenly/db/schema";
import { admitProductionProvision, claimProductionProvision, beginProductionProviderEffect, finishProductionProviderEffect } from "./store";
import { runProductionProvisionOnce } from "./worker";
import { createCoolifyDatabaseProvider } from "@wrenly/deploy";
import { hasDatabaseWork, hasMemberDatabaseWork } from "../../database-activity";
const url = process.env.WRENLY_TEST_PRODUCTION_PROVISION_DATABASE_URL;
if (url) { const parsed = new URL(url); if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/wrenly_production_setup_test") throw new Error("Use the dedicated disposable provision test database."); }
const client = postgres(url ?? "postgresql://unused:unused@127.0.0.1:1/unused", { max: 1 });
const database = drizzle(client, { schema });
const check = url ? test : test.skip;
const principal = { userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), revision: crypto.randomUUID() };
const placement = { providerId: "coolify", projectUuid: "project", serverUuid: "server", environmentUuid: "environment", destinationUuid: "destination" };
let directory = "";
beforeAll(async () => {
  if (!url) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-provision-test-"));
  await migrate(database, { migrationsFolder: resolve(import.meta.dir, "../../../../../../../packages/db/migrations") });
  await database.delete(schema.productionDatabaseProvisions);
  await database.insert(schema.user).values({ id: principal.userId, name: "Fixture owner", email: `${principal.userId}@example.test`, accessRevision: principal.revision });
  await database.insert(schema.session).values({ id: principal.sessionId, token: crypto.randomUUID(), userId: principal.userId, accessRevision: principal.revision, expiresAt: new Date(Date.now() + 600000) });
});
beforeEach(async () => { if (url) await database.delete(schema.productionDatabaseProvisions); });
afterAll(async () => { if (url) await database.delete(schema.productionDatabaseProvisions); await client.end(); if (directory) await rm(directory, { recursive: true, force: true }); });
async function fixture() {
  const [project] = await database.insert(schema.projects).values({ userId: principal.userId, name: "Production fixture" }).returning();
  if (!project) throw new Error("Project missing");
  const input = { requestId: crypto.randomUUID(), expectedRevision: project.accessRevision, confirmPrivateCreation: true };
  return { project, input };
}
check("identical requests replay and pending creation fences project/member work", async () => {
  const { project, input } = await fixture();
  const receipt = await admitProductionProvision(database, principal, project.id, input, placement, directory);
  expect((await admitProductionProvision(database, principal, project.id, input, placement, directory)).resourceId).toBe(receipt.resourceId);
  await expect(admitProductionProvision(database, principal, project.id, input, { ...placement, serverUuid: "another" }, directory)).rejects.toThrow();
  expect(await hasDatabaseWork(database, project.id)).toBe(true);
  expect(await hasMemberDatabaseWork(database, principal.userId)).toBe(true);
  await expect(admitProductionProvision(database, principal, project.id, { ...input, requestId: crypto.randomUUID() }, placement, directory)).rejects.toThrow();
});
check("effect intent is saved before decryption result leaves; repeated entry and stale acknowledgement fail", async () => {
  const { project, input } = await fixture();
  const receipt = await admitProductionProvision(database, principal, project.id, input, placement, directory);
  const claim = await claimProductionProvision(database);
  if (!claim) throw new Error("Claim missing");
  await expect(finishProductionProviderEffect(database, claim, "remote")).rejects.toThrow();
  const saved = await beginProductionProviderEffect(database, claim, directory);
  const [row] = await database.select().from(schema.productionDatabaseProvisions).where(eq(schema.productionDatabaseProvisions.id, receipt.resourceId));
  expect(row?.effectStartedAt).toBeInstanceOf(Date);
  expect(JSON.stringify(row)).not.toContain(saved.credential.password);
  await expect(beginProductionProviderEffect(database, claim, directory)).rejects.toThrow();
  await expect(finishProductionProviderEffect(database, { ...claim, token: crypto.randomUUID() }, "remote")).rejects.toThrow();
  expect((await finishProductionProviderEffect(database, claim, "remote")).status).toBe("created");
  expect(await hasDatabaseWork(database, project.id)).toBe(true);
  expect(await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.projectId, project.id))).toHaveLength(0);
});
check("expired creation never becomes queued again", async () => {
  const { project, input } = await fixture();
  const receipt = await admitProductionProvision(database, principal, project.id, input, placement, directory);
  const claim = await claimProductionProvision(database);
  if (!claim) throw new Error("Claim missing");
  await beginProductionProviderEffect(database, claim, directory);
  await database.update(schema.productionDatabaseProvisions).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.productionDatabaseProvisions.id, receipt.resourceId));
  expect(await claimProductionProvision(database)).toBeNull();
  const [row] = await database.select().from(schema.productionDatabaseProvisions).where(eq(schema.productionDatabaseProvisions.id, receipt.resourceId));
  expect(row?.status).toBe("needs_review");
  await expect(finishProductionProviderEffect(database, claim, "remote")).rejects.toThrow();
});
check("real worker sends a single create after saved intent and preserves uncertain provider effects", async () => {
  const { project, input } = await fixture();
  const receipt = await admitProductionProvision(database, principal, project.id, input, placement, directory);
  let calls = 0;
  const result = await runProductionProvisionOnce({ database, directory, signal: new AbortController().signal, providers: [createCoolifyDatabaseProvider({ request: async (method) => {
    calls++;
    expect(method).toBe("POST");
    const [row] = await database.select().from(schema.productionDatabaseProvisions).where(eq(schema.productionDatabaseProvisions.id, receipt.resourceId));
    expect(row?.effectStartedAt).toBeInstanceOf(Date);
    throw new Error("private provider failure after possible creation");
  } })] });
  expect(result?.status).toBe("needs_review");
  expect(await runProductionProvisionOnce({ database, directory, signal: new AbortController().signal, providers: [createCoolifyDatabaseProvider({ request: async () => { calls++; return {}; } })] })).toBeNull();
  expect(calls).toBe(1);
});
check("revoked session cannot retrieve management credentials or acknowledge provider creation", async () => {
  const { project, input } = await fixture();
  await admitProductionProvision(database, principal, project.id, input, placement, directory);
  const claim = await claimProductionProvision(database);
  if (!claim) throw new Error("Claim missing");
  await database.update(schema.session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.session.id, principal.sessionId));
  try {
    await expect(beginProductionProviderEffect(database, claim, directory)).rejects.toThrow();
    await expect(finishProductionProviderEffect(database, claim, "remote")).rejects.toThrow();
  } finally { await database.update(schema.session).set({ expiresAt: new Date(Date.now() + 600000) }).where(eq(schema.session.id, principal.sessionId)); }
});
check("successful worker stores the provider UUID without creating a ready application resource", async () => {
  const { project, input } = await fixture();
  const receipt = await admitProductionProvision(database, principal, project.id, input, placement, directory);
  const result = await runProductionProvisionOnce({ database, directory, signal: new AbortController().signal, providers: [createCoolifyDatabaseProvider({ request: async () => ({ uuid: "provider-created" }) })] });
  expect(result?.status).toBe("created");
  const [row] = await database.select().from(schema.productionDatabaseProvisions).where(eq(schema.productionDatabaseProvisions.id, receipt.resourceId));
  expect(row?.remoteUuid).toBe("provider-created");
  expect(row?.acknowledgedAt).toBeInstanceOf(Date);
  expect(await hasDatabaseWork(database, project.id)).toBe(true);
  expect(await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.projectId, project.id))).toHaveLength(0);
});
check("another active account and stale project revision cannot admit provider creation", async () => {
  const { project, input } = await fixture();
  const other = { userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), revision: crypto.randomUUID() };
  await database.insert(schema.user).values({ id: other.userId, name: "Other fixture", email: `${other.userId}@example.test`, accessRevision: other.revision });
  await database.insert(schema.session).values({ id: other.sessionId, token: crypto.randomUUID(), userId: other.userId, accessRevision: other.revision, expiresAt: new Date(Date.now() + 600000) });
  await expect(admitProductionProvision(database, other, project.id, input, placement, directory)).rejects.toThrow();
  await expect(admitProductionProvision(database, principal, project.id, { ...input, expectedRevision: crypto.randomUUID() }, placement, directory)).rejects.toThrow();
  expect(await database.select().from(schema.productionDatabaseProvisions).where(eq(schema.productionDatabaseProvisions.projectId, project.id))).toHaveLength(0);
});
check("orchestration accepts a different compiled adapter without Coolify placement fields", async () => {
  const { project, input } = await fixture();
  const selection = { providerId: "fixture-postgres", region: "fixture-region" };
  await admitProductionProvision(database, principal, project.id, input, selection, directory);
  let calls = 0;
  const result = await runProductionProvisionOnce({ database, directory, signal: new AbortController().signal, providers: [{
    id: "fixture-postgres",
    createStopped: async (saved, credential) => {
      calls++; expect(saved.placement).toEqual(selection);
      expect(credential.user).toContain("wrenly_"); return "fixture-remote";
    },
    inspect: async () => { throw new Error("not used by creation"); },
    find: async () => { throw new Error("not used by creation"); },
  }] });
  expect(result?.status).toBe("created"); expect(calls).toBe(1);
});
check("an unavailable saved provider never falls back to a configured Coolify adapter", async () => {
  const { project, input } = await fixture();
  await admitProductionProvision(database, principal, project.id, input, { providerId: "fixture-postgres", region: "fixture-region" }, directory);
  let calls = 0;
  await expect(runProductionProvisionOnce({ database, directory, signal: new AbortController().signal, providers: [createCoolifyDatabaseProvider({ request: async () => { calls++; return {}; } })] })).rejects.toThrow("unavailable");
  expect(calls).toBe(0);
});
