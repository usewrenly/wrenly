/** Owner-confirmed setup verification queue. No provider mutation is authorized by these records. */
import { and, asc, eq, inArray, lte } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";
import {
  productionDatabaseSetups,
  projects,
  appDatabases,
  type db,
} from "@wrenly/db";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import {
  requireProjectCapability,
  readProjectCapabilities,
} from "../../../projects/access/project-access";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  hasDatabaseWork,
} from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import { loadDatabaseKey } from "../../database-secrets";
import {
  ProductionSetupInput,
  productionSetupRequestIdentity,
  sealProductionSetup,
  openProductionSetup,
} from "./credentials";
const SETUP_LEASE_MS = 45_000;
const MAX_PENDING_SETUPS = 8;
const ACTIVE = ["queued", "checking", "needs_review"] as const;
type Connection = typeof db;
type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
type Setup = typeof productionDatabaseSetups.$inferSelect;
export interface ProductionSetupReceipt {
  setupId: string;
  status: Setup["status"];
  replayed: boolean;
}
export interface ProductionSetupClaim {
  id: string;
  token: string;
  principal: AccessPrincipal;
}
const receipt = (row: Setup, replayed: boolean): ProductionSetupReceipt => ({
  setupId: row.id,
  status: row.status,
  replayed,
});
function context<T>(
  principal: AccessPrincipal,
  run: () => Promise<T>,
): Promise<T> {
  return accessContext.run({ principal }, run);
}
async function owner(
  tx: Transaction,
  projectId: string,
  principal: AccessPrincipal,
  revision?: string,
): Promise<void> {
  await requireProjectCapability(tx, projectId, principal.userId, "manage");
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));
  if (
    !project ||
    project.userId !== principal.userId ||
    (revision && project.accessRevision !== revision)
  )
    throw new AppDatabaseError(
      409,
      "Project access changed. Review Production setup again.",
    );
}
async function key(database: Connection, directory: string): Promise<Buffer> {
  const [existing] = await database
    .select({ id: productionDatabaseSetups.id })
    .from(productionDatabaseSetups)
    .limit(1);
  return loadDatabaseKey(
    join(directory, "production-setup-keys"),
    Boolean(existing),
  );
}
/** Identical confirmation UUIDs replay; changed credentials or targets cannot reuse a receipt. */
export async function admitProductionSetup(
  database: Connection,
  principal: AccessPrincipal,
  projectId: string,
  raw: unknown,
  directory: string,
): Promise<ProductionSetupReceipt> {
  return context(principal, async () => {
    z.uuid().parse(projectId);
    const input = ProductionSetupInput.parse(raw);
    if (
      !(await readProjectCapabilities(database, projectId, principal.userId))
        ?.manage
    )
      throw new AppDatabaseError(
        403,
        "Only the project owner can configure Production.",
      );
    const encryptionKey = await key(database, directory);
    const identity = productionSetupRequestIdentity(
      projectId,
      principal.userId,
      input,
      encryptionKey,
    );
    return database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await owner(tx, projectId, principal, input.expectedRevision);
      const [replay] = await tx
        .select()
        .from(productionDatabaseSetups)
        .where(
          and(
            eq(productionDatabaseSetups.actorId, principal.userId),
            eq(productionDatabaseSetups.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (
          replay.requestIdentity !== identity ||
          replay.projectId !== projectId
        )
          throw new AppDatabaseError(
            409,
            "This setup request already represents different reviewed values.",
          );
        return receipt(replay, true);
      }
      await requireDatabaseProjectIdle(tx, projectId);
      if (await hasDatabaseWork(tx, projectId))
        throw new AppDatabaseError(
          409,
          "Finish existing database work before Production setup.",
        );
      const [resource] = await tx
        .select({ id: appDatabases.id })
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.projectId, projectId),
            eq(appDatabases.environment, "production"),
          ),
        );
      const [previous] = await tx
        .select({ id: productionDatabaseSetups.id })
        .from(productionDatabaseSetups)
        .where(
          and(
            eq(productionDatabaseSetups.projectId, projectId),
            inArray(productionDatabaseSetups.status, [...ACTIVE, "verified"]),
          ),
        );
      if (resource || previous)
        throw new AppDatabaseError(
          409,
          "This project already has Production setup or a resource to review.",
        );
      const pending = await tx
        .select({ id: productionDatabaseSetups.id })
        .from(productionDatabaseSetups)
        .where(inArray(productionDatabaseSetups.status, [...ACTIVE]))
        .limit(MAX_PENDING_SETUPS);
      if (pending.length >= MAX_PENDING_SETUPS)
        throw new AppDatabaseError(429, "Production setup capacity is full.");
      const scope = {
        id: crypto.randomUUID(),
        projectId,
        actorId: principal.userId,
        accessRevision: input.expectedRevision,
        target: input.target,
      };
      const [saved] = await tx
        .insert(productionDatabaseSetups)
        .values({
          ...scope,
          sessionId: principal.sessionId,
          accountRevision: principal.revision,
          requestId: input.requestId,
          requestIdentity: identity,
          secret: sealProductionSetup(input, scope, encryptionKey),
        })
        .returning();
      if (!saved)
        throw new AppDatabaseError(
          503,
          "Production setup receipt could not be confirmed.",
        );
      return receipt(saved, false);
    });
  });
}
/** Read-only acknowledgement does not repeat a connection check or reveal a credential. */
export async function readProductionSetupReceipt(
  database: Connection,
  principal: AccessPrincipal,
  projectId: string,
  requestId: string,
): Promise<ProductionSetupReceipt | null> {
  return context(principal, async () => {
    z.uuid().parse(projectId);
    z.uuid().parse(requestId);
    if (
      (await readProjectCapabilities(database, projectId, principal.userId))
        ?.role !== "owner"
    )
      throw new AppDatabaseError(403, "Production setup not found.");
    const [saved] = await database
      .select()
      .from(productionDatabaseSetups)
      .where(
        and(
          eq(productionDatabaseSetups.projectId, projectId),
          eq(productionDatabaseSetups.actorId, principal.userId),
          eq(productionDatabaseSetups.requestId, requestId),
        ),
      );
    return saved ? receipt(saved, true) : null;
  });
}
/** Claim once; expired verification cannot silently become provisioning or an automatic repeat. */
export async function claimProductionSetup(
  database: Connection,
): Promise<ProductionSetupClaim | null> {
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await tx
      .update(productionDatabaseSetups)
      .set({ status: "needs_review", errorCode: "verification_interrupted" })
      .where(
        and(
          eq(productionDatabaseSetups.status, "checking"),
          lte(productionDatabaseSetups.leaseExpiresAt, new Date()),
        ),
      );
    const [saved] = await tx
      .select()
      .from(productionDatabaseSetups)
      .where(eq(productionDatabaseSetups.status, "queued"))
      .orderBy(asc(productionDatabaseSetups.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!saved) return null;
    const principal = {
      userId: saved.actorId,
      sessionId: saved.sessionId,
      revision: saved.accountRevision,
    };
    return context(principal, async () => {
      try {
        await owner(tx, saved.projectId, principal, saved.accessRevision);
      } catch {
        await tx
          .update(productionDatabaseSetups)
          .set({
            status: "failed",
            errorCode: "access_changed",
            completedAt: new Date(),
          })
          .where(eq(productionDatabaseSetups.id, saved.id));
        return null;
      }
      const token = crypto.randomUUID();
      await tx
        .update(productionDatabaseSetups)
        .set({
          status: "checking",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + SETUP_LEASE_MS),
        })
        .where(eq(productionDatabaseSetups.id, saved.id));
      return { id: saved.id, token, principal };
    });
  });
}
/** Credentials are available only to the exact active verification claim and its original live owner session. */
export async function loadProductionSetup(
  database: Connection,
  claim: ProductionSetupClaim,
  directory: string,
): Promise<{
  target: Setup["target"];
  credential: { user: string; password: string };
  certificateAuthority?: string;
}> {
  const encryptionKey = await key(database, directory);
  return context(claim.principal, () =>
    database.transaction(async (tx) => {
      const [snapshot] = await tx
        .select()
        .from(productionDatabaseSetups)
        .where(eq(productionDatabaseSetups.id, claim.id));
      if (!snapshot)
        throw new AppDatabaseError(409, "Setup claim unavailable.");
      await owner(
        tx,
        snapshot.projectId,
        claim.principal,
        snapshot.accessRevision,
      );
      const [saved] = await tx
        .select()
        .from(productionDatabaseSetups)
        .where(eq(productionDatabaseSetups.id, claim.id))
        .for("update");
      if (
        !saved ||
        saved.actorId !== claim.principal.userId ||
        saved.sessionId !== claim.principal.sessionId ||
        saved.accountRevision !== claim.principal.revision ||
        saved.status !== "checking" ||
        saved.claimToken !== claim.token ||
        !saved.leaseExpiresAt ||
        saved.leaseExpiresAt.getTime() <= Date.now()
      )
        throw new AppDatabaseError(
          409,
          "Production setup claim changed or expired.",
        );
      return {
        target: saved.target,
        ...openProductionSetup(saved.secret, saved, encryptionKey),
      };
    }),
  );
}

const Inspection = z
  .object({
    clusterId: z.string().regex(/^[0-9]{1,20}$/),
    database: z.string().min(1).max(63),
    setupRole: z.string().min(1).max(63),
    serverVersion: z.number().int().min(170000).max(179999),
  })
  .strict();
/** Connection verification never establishes resource readiness; stale owners/claims cannot complete it. */
export async function finishProductionSetupCheck(
  database: Connection,
  claim: ProductionSetupClaim,
  outcome:
    | { status: "verified"; inspection: z.infer<typeof Inspection> }
    | { status: "refused" | "interrupted" },
): Promise<ProductionSetupReceipt> {
  return context(claim.principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const [snapshot] = await tx
        .select()
        .from(productionDatabaseSetups)
        .where(eq(productionDatabaseSetups.id, claim.id));
      if (!snapshot)
        throw new AppDatabaseError(409, "Setup claim unavailable.");
      await owner(
        tx,
        snapshot.projectId,
        claim.principal,
        snapshot.accessRevision,
      );
      const [saved] = await tx
        .select()
        .from(productionDatabaseSetups)
        .where(eq(productionDatabaseSetups.id, claim.id))
        .for("update");
      if (
        !saved ||
        saved.actorId !== claim.principal.userId ||
        saved.sessionId !== claim.principal.sessionId ||
        saved.accountRevision !== claim.principal.revision ||
        saved.status !== "checking" ||
        saved.claimToken !== claim.token ||
        !saved.leaseExpiresAt ||
        saved.leaseExpiresAt.getTime() <= Date.now()
      )
        throw new AppDatabaseError(
          409,
          "Production setup claim changed or expired.",
        );
      const inspection =
        outcome.status === "verified"
          ? Inspection.parse(outcome.inspection)
          : null;
      if (inspection && inspection.database !== saved.target.database)
        throw new AppDatabaseError(409, "Verified database changed.");
      const [updated] = await tx
        .update(productionDatabaseSetups)
        .set({
          status:
            outcome.status === "verified"
              ? "verified"
              : outcome.status === "refused"
                ? "failed"
                : "needs_review",
          verified: inspection,
          errorCode:
            outcome.status === "verified"
              ? null
              : outcome.status === "refused"
                ? "verification_refused"
                : "verification_interrupted",
          completedAt: outcome.status === "interrupted" ? null : new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(productionDatabaseSetups.id, saved.id))
        .returning();
      if (!updated)
        throw new AppDatabaseError(
          503,
          "Setup completion could not be confirmed.",
        );
      return receipt(updated, false);
    }),
  );
}

const InterruptedCheckAcknowledgement = z.object({
  requestId: z.uuid(),
  expectedRevision: z.uuid(),
  confirmInterruptedCheck: z.literal(true),
}).strict();
/** Closes only read-only verification uncertainty; a fresh request requires a fresh explicit confirmation. */
export async function acknowledgeInterruptedProductionCheck(
  database: Connection,
  principal: AccessPrincipal,
  projectId: string,
  raw: unknown,
): Promise<ProductionSetupReceipt> {
  const input = InterruptedCheckAcknowledgement.parse(raw);
  z.uuid().parse(projectId);
  return context(principal, () => database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await owner(tx, projectId, principal, input.expectedRevision);
    const [saved] = await tx.select().from(productionDatabaseSetups).where(and(
      eq(productionDatabaseSetups.projectId, projectId),
      eq(productionDatabaseSetups.actorId, principal.userId),
      eq(productionDatabaseSetups.requestId, input.requestId),
    )).for("update");
    if (!saved) throw new AppDatabaseError(404, "Production setup not found.");
    if (saved.status === "failed" && saved.errorCode === "verification_acknowledged") return receipt(saved, true);
    const expired = saved.status === "checking" && saved.leaseExpiresAt !== null && saved.leaseExpiresAt.getTime() <= Date.now();
    if (saved.status !== "needs_review" && !expired) throw new AppDatabaseError(409, "Only an interrupted connection check can be closed. Wait for an active check to finish.");
    const [updated] = await tx.update(productionDatabaseSetups).set({
      status: "failed", errorCode: "verification_acknowledged", completedAt: new Date(), claimToken: null, leaseExpiresAt: null,
    }).where(eq(productionDatabaseSetups.id, saved.id)).returning();
    if (!updated) throw new AppDatabaseError(503, "Connection check acknowledgement could not be confirmed.");
    return receipt(updated, false);
  }));
}
