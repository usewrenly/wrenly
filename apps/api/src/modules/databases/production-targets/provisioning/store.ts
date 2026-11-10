/** Saves provider creation before network effects; no SQL role provisioning occurs here. */
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { productionDatabaseProvisions, appDatabases, projects, type db } from "@wrenly/db";
import { accessContext, type AccessPrincipal } from "../../../auth/access/access-context";
import { requireProjectCapability } from "../../../projects/access/project-access";
import { lockDatabaseQueues, requireDatabaseProjectIdle, hasDatabaseWork } from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import { loadDatabaseKey, encryptDatabaseSecret, decryptDatabaseSecret } from "../../database-secrets";
const Placement = z.object({ projectUuid: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), serverUuid: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), environmentUuid: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), destinationUuid: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) }).strict();
const Confirmation = z.object({ requestId: z.uuid(), expectedRevision: z.uuid(), confirmPrivateCreation: z.literal(true) }).strict();
const Credential = z.object({ user: z.string().regex(/^wrenly_[a-f0-9]{32}_admin$/), password: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const LEASE_MS = 45_000;
const MAX_PENDING_CREATIONS = 8;
export const BLOCKING_PRODUCTION_PROVISION_STATUSES = ["queued", "creating", "created", "needs_review"] as const;
type Connection = typeof db;
type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
type Row = typeof productionDatabaseProvisions.$inferSelect;
export interface ProvisionReceipt { resourceId: string; status: Row["status"]; replayed: boolean }
export interface ProvisionClaim { id: string; projectId: string; token: string; principal: AccessPrincipal }
const receipt = (row: Row, replayed: boolean): ProvisionReceipt => ({ resourceId: row.id, status: row.status, replayed });
async function owner(tx: Transaction, projectId: string, principal: AccessPrincipal, revision: string): Promise<void> {
  await requireProjectCapability(tx, projectId, principal.userId, "manage");
  const [project] = await tx.select().from(projects).where(eq(projects.id, projectId));
  if (!project || project.userId !== principal.userId || project.accessRevision !== revision) throw new AppDatabaseError(409, "Project access changed. Review Production creation again.");
}
async function key(database: Connection, directory: string): Promise<Buffer> {
  const [saved] = await database.select({ id: productionDatabaseProvisions.id }).from(productionDatabaseProvisions).limit(1);
  return loadDatabaseKey(join(directory, "production-provision-keys"), Boolean(saved));
}
function scope(row: Pick<Row, "id" | "projectId" | "actorId" | "accessRevision" | "placement">): string {
  return `production-provider:v1:${createHash("sha256").update(JSON.stringify([row.id, row.projectId, row.actorId, row.accessRevision, Placement.parse(row.placement)])).digest("hex")}`;
}
/** Placement is trusted server configuration, never a browser-selected provider credential or URL. */
export async function admitProductionProvision(database: Connection, principal: AccessPrincipal, projectId: string, raw: unknown, placement: unknown, directory: string): Promise<ProvisionReceipt> {
  z.uuid().parse(projectId);
  const input = Confirmation.parse(raw), target = Placement.parse(placement);
  return accessContext.run({ principal }, async () => {
    // Authorize before key I/O. The same authority is rechecked under the ordered locks.
    await database.transaction(tx => owner(tx, projectId, principal, input.expectedRevision));
    const encryptionKey = await key(database, directory);
    const identity = createHash("sha256").update(JSON.stringify([projectId, principal.userId, input, target])).digest("hex");
    return database.transaction(async tx => {
      await lockDatabaseQueues(tx);
      await owner(tx, projectId, principal, input.expectedRevision);
      const [previous] = await tx.select().from(productionDatabaseProvisions).where(and(eq(productionDatabaseProvisions.actorId, principal.userId), eq(productionDatabaseProvisions.requestId, input.requestId)));
      if (previous) {
        if (previous.projectId !== projectId || previous.requestIdentity !== identity) throw new AppDatabaseError(409, "This creation request already represents different reviewed values.");
        return receipt(previous, true);
      }
      await requireDatabaseProjectIdle(tx, projectId);
      if (await hasDatabaseWork(tx, projectId)) throw new AppDatabaseError(409, "Finish or recover existing database work first.");
      const [resource] = await tx.select({ id: appDatabases.id }).from(appDatabases).where(and(eq(appDatabases.projectId, projectId), eq(appDatabases.environment, "production")));
      const pending = await tx.select({ id: productionDatabaseProvisions.id }).from(productionDatabaseProvisions).where(inArray(productionDatabaseProvisions.status, [...BLOCKING_PRODUCTION_PROVISION_STATUSES])).limit(MAX_PENDING_CREATIONS);
      if (resource) throw new AppDatabaseError(409, "Production already has a resource to review.");
      if (pending.length >= MAX_PENDING_CREATIONS) throw new AppDatabaseError(429, "Production creation capacity is full.");
      const id = crypto.randomUUID();
      const binding = { id, projectId, actorId: principal.userId, accessRevision: input.expectedRevision, placement: target };
      const credential = { user: `wrenly_${id.replaceAll("-", "")}_admin`, password: randomBytes(32).toString("hex") };
      const [saved] = await tx.insert(productionDatabaseProvisions).values({ ...binding, sessionId: principal.sessionId, accountRevision: principal.revision, requestId: input.requestId, requestIdentity: identity, secrets: encryptDatabaseSecret(JSON.stringify(credential), encryptionKey, scope(binding)) }).returning();
      if (!saved) throw new AppDatabaseError(503, "Production creation receipt could not be confirmed.");
      return receipt(saved, false);
    });
  });
}
/** A timed-out creation is never automatically claimed again. */
export async function claimProductionProvision(database: Connection): Promise<ProvisionClaim | null> {
  return database.transaction(async tx => {
    await lockDatabaseQueues(tx);
    await tx.update(productionDatabaseProvisions).set({ status: "needs_review", errorCode: "creation_interrupted" }).where(and(eq(productionDatabaseProvisions.status, "creating"), lte(productionDatabaseProvisions.leaseExpiresAt, new Date())));
    const [row] = await tx.select().from(productionDatabaseProvisions).where(eq(productionDatabaseProvisions.status, "queued")).orderBy(asc(productionDatabaseProvisions.createdAt)).limit(1).for("update", { skipLocked: true });
    if (!row) return null;
    const principal = { userId: row.actorId, sessionId: row.sessionId, revision: row.accountRevision };
    return accessContext.run({ principal }, async () => {
      try { await owner(tx, row.projectId, principal, row.accessRevision); }
      catch { await tx.update(productionDatabaseProvisions).set({ status: "failed", errorCode: "access_changed" }).where(eq(productionDatabaseProvisions.id, row.id)); return null; }
      const token = crypto.randomUUID();
      await tx.update(productionDatabaseProvisions).set({ status: "creating", claimToken: token, leaseExpiresAt: new Date(Date.now() + LEASE_MS) }).where(eq(productionDatabaseProvisions.id, row.id));
      return { id: row.id, projectId: row.projectId, token, principal };
    });
  });
}
async function claimed(tx: Transaction, claim: ProvisionClaim): Promise<Row> {
  const [snapshot] = await tx.select().from(productionDatabaseProvisions).where(eq(productionDatabaseProvisions.id, claim.id));
  if (!snapshot) throw new AppDatabaseError(409, "Production creation claim is unavailable.");
  await owner(tx, snapshot.projectId, claim.principal, snapshot.accessRevision);
  const [row] = await tx.select().from(productionDatabaseProvisions).where(eq(productionDatabaseProvisions.id, claim.id)).for("update");
  if (!row || row.actorId !== claim.principal.userId || row.sessionId !== claim.principal.sessionId || row.accountRevision !== claim.principal.revision || row.status !== "creating" || row.claimToken !== claim.token || !row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now()) throw new AppDatabaseError(409, "Production creation claim changed or expired.");
  return row;
}
/** Persist the remote-effect boundary before credentials can be sent to Coolify. Re-entry is refused. */
export async function beginProductionProviderEffect(database: Connection, claim: ProvisionClaim, directory: string): Promise<{ resourceId: string; operationId: string; placement: z.infer<typeof Placement>; credential: z.infer<typeof Credential> }> {
  const encryptionKey = await key(database, directory);
  return accessContext.run({ principal: claim.principal }, () => database.transaction(async tx => {
    await lockDatabaseQueues(tx);
    const row = await claimed(tx, claim);
    if (row.effectStartedAt) throw new AppDatabaseError(409, "Creation was already attempted. Inspect its saved provider identity instead of repeating it.");
    const credential = Credential.parse(JSON.parse(decryptDatabaseSecret(row.secrets, encryptionKey, scope(row))));
    if (credential.user !== `wrenly_${row.id.replaceAll("-", "")}_admin`) throw new AppDatabaseError(409, "Production credential identity changed.");
    await tx.update(productionDatabaseProvisions).set({ effectStartedAt: new Date() }).where(eq(productionDatabaseProvisions.id, row.id));
    return { resourceId: row.id, operationId: row.id, placement: Placement.parse(row.placement), credential };
  }));
}
/** Acknowledges only provider identity, not TLS, role provisioning or application readiness. */
export async function finishProductionProviderEffect(database: Connection, claim: ProvisionClaim, remoteUuid: string | null): Promise<ProvisionReceipt> {
  if (remoteUuid !== null && !/^[a-zA-Z0-9_-]{1,100}$/.test(remoteUuid)) throw new AppDatabaseError(400, "Invalid provider identity.");
  return accessContext.run({ principal: claim.principal }, () => database.transaction(async tx => {
    await lockDatabaseQueues(tx);
    const row = await claimed(tx, claim);
    if (!row.effectStartedAt) throw new AppDatabaseError(409, "No saved creation intent exists.");
    const [saved] = await tx.update(productionDatabaseProvisions).set({ status: remoteUuid ? "created" : "needs_review", remoteUuid, errorCode: remoteUuid ? null : "creation_unconfirmed", acknowledgedAt: remoteUuid ? new Date() : null, claimToken: null, leaseExpiresAt: null }).where(eq(productionDatabaseProvisions.id, row.id)).returning();
    if (!saved) throw new AppDatabaseError(503, "Provider acknowledgement could not be confirmed.");
    return receipt(saved, false);
  }));
}

/** Startup checks the journal even when Production provisioning is disabled, because admission fences read it. */
export async function verifyProductionProvisionSchema(database: Connection): Promise<void> {
  try { await database.select().from(productionDatabaseProvisions).limit(1); }
  catch { throw new Error("Production creation persistence is unavailable. Apply all checked-in database migrations before starting Wrenly."); }
}
