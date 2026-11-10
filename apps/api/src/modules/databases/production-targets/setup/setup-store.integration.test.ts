/** Exercises saved setup authority and claims against a disposable control database. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "@wrenly/db/app-database-driver";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as schema from "@wrenly/db/schema";
import { acknowledgeInterruptedProductionCheck, admitProductionSetup, claimProductionSetup, loadProductionSetup, finishProductionSetupCheck, readProductionSetupReceipt } from "./setup-store";
const url = process.env.WRENLY_TEST_PRODUCTION_SETUP_DATABASE_URL;
const enabled = Boolean(url);
if (url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/wrenly_production_setup_test") throw new Error("Use the dedicated disposable setup test database.");
}
const client = postgres(url ?? "postgresql://unused:unused@127.0.0.1:1/unused", { max: 1 });
const database = drizzle(client, { schema });
let directory = "";
const principal = { userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), revision: crypto.randomUUID() };
beforeAll(async () => {
  if (!enabled) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-setup-test-"));
  await migrate(database, { migrationsFolder: resolve(import.meta.dir, "../../../../../../../packages/db/migrations") });
  await database.delete(schema.productionDatabaseSetups);
  await database.insert(schema.user).values({ id: principal.userId, name: "Fixture owner", email: `${principal.userId}@example.test`, accessRevision: principal.revision });
  await database.insert(schema.session).values({ id: principal.sessionId, token: crypto.randomUUID(), userId: principal.userId, accessRevision: principal.revision, expiresAt: new Date(Date.now() + 600000) });
});
afterAll(async () => { if (enabled) await database.delete(schema.productionDatabaseSetups); await client.end(); if (directory) await rm(directory, { recursive: true, force: true }); });
const check = enabled ? test : test.skip;
async function fixture() {
  const [project] = await database.insert(schema.projects).values({ userId: principal.userId, name: "Setup fixture" }).returning();
  if (!project) throw new Error("Fixture project missing");
  return { project, input: { requestId: crypto.randomUUID(), expectedRevision: project.accessRevision, confirmTarget: true as const, target: { version: 1 as const, environment: "production" as const, host: "database.internal.test", port: 5432, database: "app", sslmode: "verify-full" as const }, credential: { user: "setup_user", password: "fixture-private-password" } } };
}
check("confirmation replays exactly, encrypts secrets and rejects changed intent", async () => {
  const { project, input } = await fixture();
  const first = await admitProductionSetup(database, principal, project.id, input, directory);
  expect((await admitProductionSetup(database, principal, project.id, input, directory)).setupId).toBe(first.setupId);
  await expect(admitProductionSetup(database, principal, project.id, { ...input, credential: { ...input.credential, password: "different" } }, directory)).rejects.toThrow();
  const [saved] = await database.select().from(schema.productionDatabaseSetups).where(eq(schema.productionDatabaseSetups.id, first.setupId));
  expect(JSON.stringify(saved)).not.toContain(input.credential.password);
  const receipt = await readProductionSetupReceipt(database, principal, project.id, input.requestId);
  expect(Object.keys(receipt ?? {}).sort()).toEqual(["replayed", "setupId", "status"]);
  const claim = await claimProductionSetup(database);
  expect(claim?.id).toBe(first.setupId);
  if (!claim) throw new Error("Claim missing");
  expect((await loadProductionSetup(database, claim, directory)).credential).toEqual(input.credential);
  await expect(loadProductionSetup(database, { ...claim, token: crypto.randomUUID() }, directory)).rejects.toThrow();
  await finishProductionSetupCheck(database, claim, { status: "verified", inspection: { clusterId: "123456789", database: "app", setupRole: "setup_user", serverVersion: 170000 } });
  expect((await readProductionSetupReceipt(database, principal, project.id, input.requestId))?.status).toBe("verified");
  expect(await database.select().from(schema.appDatabases).where(eq(schema.appDatabases.projectId, project.id))).toHaveLength(0);
});
check("expired claims require review and cannot complete or restart automatically", async () => {
  const { project, input } = await fixture();
  const saved = await admitProductionSetup(database, principal, project.id, input, directory);
  const claim = await claimProductionSetup(database);
  if (!claim) throw new Error("Claim missing");
  await database.update(schema.productionDatabaseSetups).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.productionDatabaseSetups.id, saved.setupId));
  expect(await claimProductionSetup(database)).toBeNull();
  expect((await readProductionSetupReceipt(database, principal, project.id, input.requestId))?.status).toBe("needs_review");
  await expect(finishProductionSetupCheck(database, claim, { status: "refused" })).rejects.toThrow();
});
check("revoked sessions cannot decrypt or finish a saved claim", async () => {
  const { project, input } = await fixture();
  await admitProductionSetup(database, principal, project.id, input, directory);
  const claim = await claimProductionSetup(database);
  if (!claim) throw new Error("Claim missing");
  await database.update(schema.session).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.session.id, principal.sessionId));
  try {
    await expect(loadProductionSetup(database, claim, directory)).rejects.toThrow();
    await expect(finishProductionSetupCheck(database, claim, { status: "refused" })).rejects.toThrow();
  } finally {
    await database.update(schema.session).set({ expiresAt: new Date(Date.now() + 600000) }).where(eq(schema.session.id, principal.sessionId));
    await finishProductionSetupCheck(database, claim, { status: "refused" });
  }
});
check("another signed-in account cannot confirm or read the owner's setup", async () => {
  const { project, input } = await fixture();
  const other = { userId: crypto.randomUUID(), sessionId: crypto.randomUUID(), revision: crypto.randomUUID() };
  await database.insert(schema.user).values({ id: other.userId, name: "Other fixture", email: `${other.userId}@example.test`, accessRevision: other.revision });
  await database.insert(schema.session).values({ id: other.sessionId, token: crypto.randomUUID(), userId: other.userId, accessRevision: other.revision, expiresAt: new Date(Date.now() + 600000) });
  await expect(admitProductionSetup(database, other, project.id, input, directory)).rejects.toThrow();
  await expect(readProductionSetupReceipt(database, other, project.id, input.requestId)).rejects.toThrow();
});

check("owner closes interrupted verification without replaying it and stale workers stay fenced", async () => {
  const { project, input } = await fixture();
  const saved = await admitProductionSetup(database, principal, project.id, input, directory);
  const claim = await claimProductionSetup(database);
  if (!claim) throw new Error("Claim missing");
  const acknowledgement = { requestId: input.requestId, expectedRevision: input.expectedRevision, confirmInterruptedCheck: true };
  await expect(acknowledgeInterruptedProductionCheck(database, principal, project.id, acknowledgement)).rejects.toThrow();
  await database.update(schema.productionDatabaseSetups).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.productionDatabaseSetups.id, saved.setupId));
  expect((await acknowledgeInterruptedProductionCheck(database, principal, project.id, acknowledgement)).status).toBe("failed");
  expect((await acknowledgeInterruptedProductionCheck(database, principal, project.id, acknowledgement)).replayed).toBe(true);
  await expect(finishProductionSetupCheck(database, claim, { status: "refused" })).rejects.toThrow();
  const next = await admitProductionSetup(database, principal, project.id, { ...input, requestId: crypto.randomUUID() }, directory);
  expect(next.setupId).not.toBe(saved.setupId);
});
