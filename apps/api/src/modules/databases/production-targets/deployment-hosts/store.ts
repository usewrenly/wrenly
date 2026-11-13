import { hasUnfinishedMaintenance } from "../../database-activity";
/** Saved instance connection revisions make server setup reusable without retargeting existing projects. */
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { join } from "node:path";
import { z } from "zod";
import {
  productionRuntimeHosts,
  productionDatabaseProvisions,
  productionDatabaseSetups,
  appDatabaseOperations,
  deployments,
  instanceSetup,
  type db,
} from "@wrenly/db";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { assertActiveAccount } from "../../../auth/access/access-policy";
import { lockDatabaseQueues } from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import { loadDatabaseKey } from "../../database-secrets";
import {
  runtimeHostRequestIdentity,
  sealRuntimeHostCredential,
  openRuntimeHostCredential,
} from "./credentials";
import {
  ProductionRuntimeHostInput,
  ProductionRuntimeHostIdentity,
} from "@wrenly/db/production-host-contract";

const LEASE_MS = 45_000;
const ACTIVE = ["queued", "checking", "needs_review"] as const;
type Connection = typeof db;
type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
type Saved = typeof productionRuntimeHosts.$inferSelect;
export interface RuntimeHostReceipt {
  connectionId: string;
  status: Saved["status"];
  replayed: boolean;
}
export interface RuntimeHostClaim {
  id: string;
  token: string;
  principal: AccessPrincipal;
}
const receipt = (row: Saved, replayed: boolean): RuntimeHostReceipt => ({
  connectionId: row.id,
  status: row.status,
  replayed,
});
function asPrincipal<T>(
  principal: AccessPrincipal,
  run: () => Promise<T>,
): Promise<T> {
  return accessContext.run({ principal }, run);
}
async function owner(
  tx: Transaction,
  principal: AccessPrincipal,
): Promise<void> {
  await assertActiveAccount(tx, principal.userId);
  const [setup] = await tx
    .select({ ownerId: instanceSetup.ownerId })
    .from(instanceSetup)
    .where(eq(instanceSetup.id, 1))
    .for("update");
  if (setup?.ownerId !== principal.userId)
    throw new AppDatabaseError(
      403,
      "Only the instance owner can configure the deployment host.",
    );
}
async function encryptionKey(
  database: Connection,
  directory: string,
): Promise<Buffer> {
  const [saved] = await database
    .select({ id: productionRuntimeHosts.id })
    .from(productionRuntimeHosts)
    .limit(1);
  return loadDatabaseKey(
    join(directory, "production-host-keys"),
    Boolean(saved),
  );
}
async function requireIdle(tx: Transaction): Promise<void> {
  if (await hasUnfinishedMaintenance(tx))
    throw new AppDatabaseError(
      409,
      "Finish or review runtime maintenance before changing the server connection.",
    );
  const [operation] = await tx
    .select({ id: appDatabaseOperations.id })
    .from(appDatabaseOperations)
    .where(
      inArray(appDatabaseOperations.status, [
        "queued",
        "running",
        "interrupted",
      ]),
    )
    .limit(1);
  const [provision] = await tx
    .select({ id: productionDatabaseProvisions.id })
    .from(productionDatabaseProvisions)
    .where(
      inArray(productionDatabaseProvisions.status, [
        "queued",
        "creating",
        "created",
        "needs_review",
      ]),
    )
    .limit(1);
  const [oldCheck] = await tx
    .select({ id: productionDatabaseSetups.id })
    .from(productionDatabaseSetups)
    .where(inArray(productionDatabaseSetups.status, [...ACTIVE]))
    .limit(1);
  const [publishing] = await tx
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      inArray(deployments.status, [
        "queued",
        "preparing",
        "deploying",
        "verifying",
        "interrupted",
      ]),
    )
    .limit(1);
  if (operation || provision || oldCheck || publishing)
    throw new AppDatabaseError(
      409,
      "Finish or review existing database work before changing the deployment host connection.",
    );
}
/** Exact request replay returns its receipt; changed values and stale connection revisions cannot reuse it. */
export async function admitRuntimeHostConnection(
  database: Connection,
  principal: AccessPrincipal,
  raw: unknown,
  directory: string,
): Promise<RuntimeHostReceipt> {
  const input = ProductionRuntimeHostInput.parse(raw);
  // Never create an instance key directory on behalf of an unauthorized account.
  await asPrincipal(principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await owner(tx, principal);
    }),
  );
  const key = await encryptionKey(database, directory);
  const identity = runtimeHostRequestIdentity(input, principal.userId, key);
  return asPrincipal(principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await owner(tx, principal);
      const [replay] = await tx
        .select()
        .from(productionRuntimeHosts)
        .where(
          and(
            eq(productionRuntimeHosts.actorId, principal.userId),
            eq(productionRuntimeHosts.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (replay.requestIdentity !== identity)
          throw new AppDatabaseError(
            409,
            "This request already represents different connection values.",
          );
        return receipt(replay, true);
      }
      const [latest] = await tx
        .select()
        .from(productionRuntimeHosts)
        .orderBy(
          desc(productionRuntimeHosts.createdAt),
          desc(productionRuntimeHosts.id),
        )
        .limit(1);
      if ((latest?.id ?? null) !== input.expectedConnectionId)
        throw new AppDatabaseError(
          409,
          "The deployment host connection changed. Reload and review it first.",
        );
      if (latest && ACTIVE.includes(latest.status as (typeof ACTIVE)[number]))
        throw new AppDatabaseError(
          409,
          "Finish or review the saved connection check first.",
        );
      await requireIdle(tx);
      const scope = {
        id: crypto.randomUUID(),
        actorId: principal.userId,
        target: input.target,
        serverId: input.serverId,
      };
      const [saved] = await tx
        .insert(productionRuntimeHosts)
        .values({
          ...scope,
          previousId: input.expectedConnectionId,
          sessionId: principal.sessionId,
          accountRevision: principal.revision,
          requestId: input.requestId,
          requestIdentity: identity,
          secret: sealRuntimeHostCredential(input, scope, key),
        })
        .returning();
      if (!saved)
        throw new AppDatabaseError(
          503,
          "Connection receipt could not be confirmed.",
        );
      return receipt(saved, false);
    }),
  );
}
/** Owner-only status never decrypts or exposes credentials, CA text or internal error details. */
export async function readRuntimeHostConnection(
  database: Connection,
  principal: AccessPrincipal,
  requestId?: string,
): Promise<{
  connectionId: string;
  status: Saved["status"];
  target: Saved["target"];
  serverId: string;
  verified: Saved["verified"];
} | null> {
  return asPrincipal(principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await owner(tx, principal);
      if (requestId !== undefined) z.uuid().parse(requestId);
      const [saved] = await tx
        .select()
        .from(productionRuntimeHosts)
        .where(
          requestId === undefined
            ? undefined
            : and(
                eq(productionRuntimeHosts.actorId, principal.userId),
                eq(productionRuntimeHosts.requestId, requestId),
              ),
        )
        .orderBy(
          desc(productionRuntimeHosts.createdAt),
          desc(productionRuntimeHosts.id),
        )
        .limit(1);
      return saved
        ? {
            connectionId: saved.id,
            status: saved.status,
            target: saved.target,
            serverId: saved.serverId,
            verified: saved.verified,
          }
        : null;
    }),
  );
}
/** A crashed read-only verification becomes review-required; it is never silently repeated. */
export async function claimRuntimeHostConnection(
  database: Connection,
): Promise<RuntimeHostClaim | null> {
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await tx
      .update(productionRuntimeHosts)
      .set({ status: "needs_review", errorCode: "verification_interrupted" })
      .where(
        and(
          eq(productionRuntimeHosts.status, "checking"),
          lte(productionRuntimeHosts.leaseExpiresAt, new Date()),
        ),
      );
    const [saved] = await tx
      .select()
      .from(productionRuntimeHosts)
      .where(eq(productionRuntimeHosts.status, "queued"))
      .orderBy(asc(productionRuntimeHosts.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!saved) return null;
    const principal = {
      userId: saved.actorId,
      sessionId: saved.sessionId,
      revision: saved.accountRevision,
    };
    return asPrincipal(principal, async () => {
      try {
        await owner(tx, principal);
      } catch {
        await tx
          .update(productionRuntimeHosts)
          .set({
            status: "failed",
            errorCode: "access_changed",
            completedAt: new Date(),
          })
          .where(eq(productionRuntimeHosts.id, saved.id));
        return null;
      }
      const token = crypto.randomUUID();
      await tx
        .update(productionRuntimeHosts)
        .set({
          status: "checking",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        })
        .where(eq(productionRuntimeHosts.id, saved.id));
      return { id: saved.id, token, principal };
    });
  });
}
async function claimed(
  tx: Transaction,
  claim: RuntimeHostClaim,
): Promise<Saved> {
  await owner(tx, claim.principal);
  const [saved] = await tx
    .select()
    .from(productionRuntimeHosts)
    .where(eq(productionRuntimeHosts.id, claim.id))
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
    throw new AppDatabaseError(409, "Connection check changed or expired.");
  return saved;
}
/** The management secret is decrypted only for the exact still-authorized work claim. */
export async function loadRuntimeHostConnection(
  database: Connection,
  claim: RuntimeHostClaim,
  directory: string,
): Promise<{
  target: Saved["target"];
  privateKey: string;
  serverId: string;
}> {
  const key = await encryptionKey(database, directory);
  return asPrincipal(claim.principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const saved = await claimed(tx, claim);
      return {
        target: saved.target,
        privateKey: openRuntimeHostCredential(saved.secret, saved, key),
        serverId: saved.serverId,
      };
    }),
  );
}
/** Freezes authenticated cluster and DNS facts; this never marks an application database ready. */
export async function finishRuntimeHostConnection(
  database: Connection,
  claim: RuntimeHostClaim,
  outcome:
    | {
        status: "verified";
        inspection: ProductionRuntimeHostIdentity;
        pinned: {
          target: ProductionRuntimeHostInput["target"];
          addresses: string[];
        };
      }
    | { status: "refused" | "interrupted" },
): Promise<RuntimeHostReceipt> {
  return asPrincipal(claim.principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const saved = await claimed(tx, claim);
      const verified =
        outcome.status === "verified"
          ? ProductionRuntimeHostIdentity.parse(outcome.inspection)
          : null;
      let pinnedAddresses: string[] | null = null;
      if (outcome.status === "verified") {
        if (
          JSON.stringify(
            ProductionRuntimeHostInput.shape.target.parse(
              outcome.pinned.target,
            ),
          ) !==
          JSON.stringify(
            ProductionRuntimeHostInput.shape.target.parse(saved.target),
          )
        )
          throw new AppDatabaseError(
            409,
            "Verified connection identity changed.",
          );
        pinnedAddresses = z
          .array(z.ipv4())
          .min(1)
          .max(16)
          .parse(outcome.pinned.addresses);
        if (new Set(pinnedAddresses).size !== pinnedAddresses.length)
          throw new AppDatabaseError(409, "Ambiguous verified addresses.");
      }
      const [updated] = await tx
        .update(productionRuntimeHosts)
        .set({
          status:
            outcome.status === "verified"
              ? "verified"
              : outcome.status === "refused"
                ? "failed"
                : "needs_review",
          verified,
          pinnedAddresses,
          claimToken: null,
          leaseExpiresAt: null,
          errorCode:
            outcome.status === "verified"
              ? null
              : outcome.status === "refused"
                ? "verification_refused"
                : "verification_interrupted",
          completedAt: outcome.status === "interrupted" ? null : new Date(),
        })
        .where(eq(productionRuntimeHosts.id, saved.id))
        .returning();
      if (!updated)
        throw new AppDatabaseError(
          503,
          "Connection completion could not be confirmed.",
        );
      return receipt(updated, false);
    }),
  );
}
/** Explicitly closes only interrupted read-only checks, allowing a newly reviewed request. */
export async function acknowledgeRuntimeHostCheck(
  database: Connection,
  principal: AccessPrincipal,
  connectionId: string,
): Promise<RuntimeHostReceipt> {
  z.uuid().parse(connectionId);
  return asPrincipal(principal, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await owner(tx, principal);
      const [saved] = await tx
        .select()
        .from(productionRuntimeHosts)
        .where(eq(productionRuntimeHosts.id, connectionId))
        .for("update");
      if (!saved)
        throw new AppDatabaseError(404, "Connection check not found.");
      if (
        saved.status === "failed" &&
        saved.errorCode === "verification_acknowledged"
      )
        return receipt(saved, true);
      const expired =
        saved.status === "checking" &&
        saved.leaseExpiresAt !== null &&
        saved.leaseExpiresAt.getTime() <= Date.now();
      if (saved.status !== "needs_review" && !expired)
        throw new AppDatabaseError(
          409,
          "Only an interrupted connection check can be closed.",
        );
      const [updated] = await tx
        .update(productionRuntimeHosts)
        .set({
          status: "failed",
          errorCode: "verification_acknowledged",
          completedAt: new Date(),
          claimToken: null,
          leaseExpiresAt: null,
        })
        .where(eq(productionRuntimeHosts.id, saved.id))
        .returning();
      if (!updated)
        throw new AppDatabaseError(
          503,
          "Connection acknowledgement could not be confirmed.",
        );
      return receipt(updated, false);
    }),
  );
}

/** Fail startup before shared account checks can encounter an absent connection journal. */
export async function verifyRuntimeHostConnectionSchema(
  database: Connection,
): Promise<void> {
  try {
    await database
      .select({ id: productionRuntimeHosts.id })
      .from(productionRuntimeHosts)
      .limit(0);
  } catch {
    throw new Error(
      "Deployment host storage is unavailable. Apply checked-in migrations through 0045 before starting Wrenly.",
    );
  }
}
