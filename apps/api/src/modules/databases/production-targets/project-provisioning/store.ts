/** Project-owner admission and separately durable SQL phases on one immutable verified instance connection. */
import { and, asc, desc, eq, inArray, lte } from "drizzle-orm";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  productionDatabaseProvisions,
  productionDatabaseConnections,
  projects,
  appDatabases,
  type db,
} from "@wrenly/db";
import {
  createProductionProjectCredentials,
  validateProductionProjectCredentials,
  PRODUCTION_PROVISION_PHASES,
  ProductionProvisionPhase,
  type ProductionProjectCredentials,
} from "@wrenly/db/production-project-credentials";
import {
  accessContext,
  type AccessPrincipal,
} from "../../../auth/access/access-context";
import { requireProjectCapability } from "../../../projects/access/project-access";
import {
  lockDatabaseQueues,
  requireDatabaseProjectIdle,
  hasDatabaseWork,
} from "../../database-store";
import { AppDatabaseError } from "../../database-contract";
import {
  loadDatabaseKey,
  encryptDatabaseSecret,
  decryptDatabaseSecret,
} from "../../database-secrets";
import { openProductionConnection } from "../instance/credentials";
const Confirmation = z
  .object({
    requestId: z.uuid(),
    expectedRevision: z.uuid(),
    connectionId: z.uuid(),
    confirmCreate: z.literal(true),
  })
  .strict();
const LEASE_MS = 60_000;
const MAX_PENDING = 8;
type Connection = typeof db;
type Transaction = Parameters<Parameters<Connection["transaction"]>[0]>[0];
type Row = typeof productionDatabaseProvisions.$inferSelect;
export interface ProjectProvisionReceipt {
  resourceId: string;
  status: Row["status"];
  completedPhases: ProductionProvisionPhase[];
  replayed: boolean;
}
export interface ProjectProvisionClaim {
  id: string;
  projectId: string;
  token: string;
  principal: AccessPrincipal;
  completedPhases: ProductionProvisionPhase[];
}
function receipt(row: Row, replayed: boolean): ProjectProvisionReceipt {
  return {
    resourceId: row.id,
    status: row.status,
    completedPhases: row.completedPhases,
    replayed,
  };
}
/** Rechecks the live owner session and exact project access revision under ordered queue locks. */
export async function requireProductionProjectOwner(
  tx: Transaction,
  projectId: string,
  actor: AccessPrincipal,
  revision?: string,
): Promise<void> {
  await requireProjectCapability(tx, projectId, actor.userId, "manage");
  const [project] = await tx
    .select()
    .from(projects)
    .where(eq(projects.id, projectId));
  if (
    !project ||
    project.userId !== actor.userId ||
    (revision && project.accessRevision !== revision)
  )
    throw new AppDatabaseError(
      409,
      "Project access changed. Review Production creation again.",
    );
}
/** Authenticated data keeps project credentials bound to their original resource and server revision. */
export function productionProjectSecretPurpose(
  row: Pick<
    Row,
    "id" | "projectId" | "connectionId" | "actorId" | "accessRevision"
  >,
): string {
  if (!row.connectionId) throw new Error("Missing saved server connection");
  return `production-project:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.projectId,
        row.connectionId,
        row.actorId,
        row.accessRevision,
      ]),
    )
    .digest("hex")}`;
}
/** Existing encrypted requests require their original instance-local key; it is never replaced. */
export async function loadProductionProjectKey(
  database: Connection,
  directory: string,
): Promise<Buffer> {
  const [saved] = await database
    .select({ id: productionDatabaseProvisions.id })
    .from(productionDatabaseProvisions)
    .where(eq(productionDatabaseProvisions.mode, "cluster"))
    .limit(1);
  return loadDatabaseKey(
    join(directory, "production-project-keys"),
    Boolean(saved),
  );
}
/** Explicit confirmation freezes the verified server revision and creates passwords once, never during retry. */
export async function admitProjectProductionProvision(
  database: Connection,
  actor: AccessPrincipal,
  projectId: string,
  raw: unknown,
  directory: string,
): Promise<ProjectProvisionReceipt> {
  z.uuid().parse(projectId);
  const input = Confirmation.parse(raw);
  return accessContext.run({ principal: actor }, async () => {
    await database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProductionProjectOwner(
        tx,
        projectId,
        actor,
        input.expectedRevision,
      );
    });
    const key = await loadProductionProjectKey(database, directory);
    const identity = createHash("sha256")
      .update(JSON.stringify([projectId, actor.userId, input]))
      .digest("hex");
    return database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      await requireProductionProjectOwner(
        tx,
        projectId,
        actor,
        input.expectedRevision,
      );
      const [replay] = await tx
        .select()
        .from(productionDatabaseProvisions)
        .where(
          and(
            eq(productionDatabaseProvisions.actorId, actor.userId),
            eq(productionDatabaseProvisions.requestId, input.requestId),
          ),
        );
      if (replay) {
        if (
          replay.mode !== "cluster" ||
          replay.projectId !== projectId ||
          replay.requestIdentity !== identity
        )
          throw new AppDatabaseError(
            409,
            "This creation request represents different reviewed values.",
          );
        return receipt(replay, true);
      }
      await requireDatabaseProjectIdle(tx, projectId);
      if (await hasDatabaseWork(tx, projectId))
        throw new AppDatabaseError(
          409,
          "Finish or recover this project's database work first.",
        );
      const [existing] = await tx
        .select({ id: appDatabases.id })
        .from(appDatabases)
        .where(
          and(
            eq(appDatabases.projectId, projectId),
            eq(appDatabases.environment, "production"),
          ),
        );
      if (existing)
        throw new AppDatabaseError(
          409,
          "This project already has a Production resource.",
        );
      const [server] = await tx
        .select()
        .from(productionDatabaseConnections)
        .orderBy(
          desc(productionDatabaseConnections.createdAt),
          desc(productionDatabaseConnections.id),
        )
        .limit(1);
      if (
        !server ||
        server.id !== input.connectionId ||
        server.status !== "verified" ||
        !server.verified ||
        !server.pinnedAddresses?.length
      )
        throw new AppDatabaseError(
          409,
          "The instance owner must verify the Production server connection first.",
        );
      const pending = await tx
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
        .limit(MAX_PENDING);
      if (pending.length >= MAX_PENDING)
        throw new AppDatabaseError(
          429,
          "Production creation capacity is full.",
        );
      const id = crypto.randomUUID();
      const credentials = createProductionProjectCredentials(id);
      const binding = {
        id,
        projectId,
        actorId: actor.userId,
        accessRevision: input.expectedRevision,
        connectionId: server.id,
      };
      const [saved] = await tx
        .insert(productionDatabaseProvisions)
        .values({
          ...binding,
          mode: "cluster",
          placement: { providerId: "postgres-cluster" },
          sessionId: actor.sessionId,
          accountRevision: actor.revision,
          requestId: input.requestId,
          requestIdentity: identity,
          secrets: encryptDatabaseSecret(
            JSON.stringify(credentials),
            key,
            productionProjectSecretPurpose(binding),
          ),
        })
        .returning();
      if (!saved)
        throw new AppDatabaseError(
          503,
          "Production creation receipt could not be confirmed.",
        );
      return receipt(saved, false);
    });
  });
}
/** Claims no provider-mode request and never reclaims an expired SQL attempt. */
export async function claimProjectProductionProvision(
  database: Connection,
): Promise<ProjectProvisionClaim | null> {
  return database.transaction(async (tx) => {
    await lockDatabaseQueues(tx);
    await tx
      .update(productionDatabaseProvisions)
      .set({ status: "needs_review", errorCode: "sql_creation_interrupted" })
      .where(
        and(
          eq(productionDatabaseProvisions.mode, "cluster"),
          eq(productionDatabaseProvisions.status, "creating"),
          lte(productionDatabaseProvisions.leaseExpiresAt, new Date()),
        ),
      );
    const [saved] = await tx
      .select()
      .from(productionDatabaseProvisions)
      .where(
        and(
          eq(productionDatabaseProvisions.mode, "cluster"),
          eq(productionDatabaseProvisions.status, "queued"),
        ),
      )
      .orderBy(asc(productionDatabaseProvisions.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!saved) return null;
    const actor = saved.executionPrincipal ?? {
      userId: saved.actorId,
      sessionId: saved.sessionId,
      revision: saved.accountRevision,
    };
    return accessContext.run({ principal: actor }, async () => {
      try {
        await requireProductionProjectOwner(
          tx,
          saved.projectId,
          actor,
          saved.accessRevision,
        );
      } catch {
        await tx
          .update(productionDatabaseProvisions)
          .set({ status: "failed", errorCode: "access_changed" })
          .where(eq(productionDatabaseProvisions.id, saved.id));
        return null;
      }
      const token = crypto.randomUUID();
      await tx
        .update(productionDatabaseProvisions)
        .set({
          status: "creating",
          claimToken: token,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        })
        .where(eq(productionDatabaseProvisions.id, saved.id));
      return {
        id: saved.id,
        projectId: saved.projectId,
        token,
        principal: actor,
        completedPhases: saved.completedPhases,
      };
    });
  });
}
async function claimed(
  tx: Transaction,
  claim: ProjectProvisionClaim,
): Promise<Row> {
  const [snapshot] = await tx
    .select()
    .from(productionDatabaseProvisions)
    .where(eq(productionDatabaseProvisions.id, claim.id));
  if (!snapshot) throw new AppDatabaseError(409, "Creation claim unavailable.");
  await requireProductionProjectOwner(
    tx,
    snapshot.projectId,
    claim.principal,
    snapshot.accessRevision,
  );
  const [saved] = await tx
    .select()
    .from(productionDatabaseProvisions)
    .where(eq(productionDatabaseProvisions.id, claim.id))
    .for("update");
  const execution =
    saved?.executionPrincipal ??
    (saved
      ? {
          userId: saved.actorId,
          sessionId: saved.sessionId,
          revision: saved.accountRevision,
        }
      : null);
  if (
    !saved ||
    saved.mode !== "cluster" ||
    saved.projectId !== claim.projectId ||
    saved.actorId !== claim.principal.userId ||
    execution?.userId !== claim.principal.userId ||
    execution?.sessionId !== claim.principal.sessionId ||
    execution?.revision !== claim.principal.revision ||
    saved.status !== "creating" ||
    saved.claimToken !== claim.token ||
    !saved.leaseExpiresAt ||
    saved.leaseExpiresAt.getTime() <= Date.now()
  )
    throw new AppDatabaseError(409, "Creation claim changed or expired.");
  const phases = z
    .array(ProductionProvisionPhase)
    .max(PRODUCTION_PROVISION_PHASES.length)
    .parse(saved.completedPhases);
  if (
    phases.some((phase, index) => phase !== PRODUCTION_PROVISION_PHASES[index])
  )
    throw new AppDatabaseError(409, "Creation phase history needs review.");
  return saved;
}
/** Persists SQL intent before releasing project or management credentials to the exact claim. */
export async function beginProjectProductionPhase(
  database: Connection,
  claim: ProjectProvisionClaim,
  phase: ProductionProvisionPhase,
  directory: string,
): Promise<{
  credentials: ProductionProjectCredentials;
  server: {
    target: (typeof productionDatabaseConnections.$inferSelect)["target"];
    addresses: string[];
    clusterId: string;
    credential: { user: string; password: string };
    certificateAuthority?: string;
  };
}> {
  ProductionProvisionPhase.parse(phase);
  const key = await loadProductionProjectKey(database, directory);
  const instanceKey = await loadDatabaseKey(
    join(directory, "production-instance-keys"),
    true,
  );
  return accessContext.run({ principal: claim.principal }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const saved = await claimed(tx, claim);
      if (
        saved.effectPhase ||
        PRODUCTION_PROVISION_PHASES[saved.completedPhases.length] !== phase
      )
        throw new AppDatabaseError(
          409,
          "Inspect the saved SQL phase before advancing or repeating it.",
        );
      const [server] = await tx
        .select()
        .from(productionDatabaseConnections)
        .where(eq(productionDatabaseConnections.id, saved.connectionId!));
      if (
        !server ||
        server.status !== "verified" ||
        !server.verified ||
        !server.pinnedAddresses?.length
      )
        throw new AppDatabaseError(
          409,
          "Saved Production server verification is unavailable.",
        );
      const credentials = validateProductionProjectCredentials(
        saved.id,
        JSON.parse(
          decryptDatabaseSecret(
            saved.secrets,
            key,
            productionProjectSecretPurpose(saved),
          ),
        ),
      );
      const management = openProductionConnection(
        server.secret,
        server,
        instanceKey,
      );
      await tx
        .update(productionDatabaseProvisions)
        .set({
          effectPhase: phase,
          effectStartedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
        })
        .where(eq(productionDatabaseProvisions.id, saved.id));
      return {
        credentials,
        server: {
          target: server.target,
          addresses: server.pinnedAddresses,
          clusterId: server.verified.clusterId,
          ...management,
        },
      };
    }),
  );
}
/** Lost SQL or persistence acknowledgements never authorize another attempt of that phase. */
export async function finishProjectProductionPhase(
  database: Connection,
  claim: ProjectProvisionClaim,
  phase: ProductionProvisionPhase,
  confirmed: boolean,
): Promise<ProjectProvisionReceipt> {
  ProductionProvisionPhase.parse(phase);
  return accessContext.run({ principal: claim.principal }, () =>
    database.transaction(async (tx) => {
      await lockDatabaseQueues(tx);
      const saved = await claimed(tx, claim);
      if (
        saved.effectPhase !== phase ||
        !saved.effectStartedAt ||
        PRODUCTION_PROVISION_PHASES[saved.completedPhases.length] !== phase
      )
        throw new AppDatabaseError(409, "No matching SQL phase intent exists.");
      const completedPhases = confirmed
        ? [...saved.completedPhases, phase]
        : saved.completedPhases;
      const terminal =
        confirmed &&
        completedPhases.length === PRODUCTION_PROVISION_PHASES.length;
      const [updated] = await tx
        .update(productionDatabaseProvisions)
        .set({
          completedPhases,
          status: !confirmed
            ? "needs_review"
            : terminal
              ? "created"
              : "creating",
          effectPhase: confirmed ? null : phase,
          effectStartedAt: confirmed ? null : saved.effectStartedAt,
          errorCode: confirmed ? null : "sql_phase_unconfirmed",
          acknowledgedAt: terminal ? new Date() : null,
          claimToken: !confirmed || terminal ? null : saved.claimToken,
          leaseExpiresAt:
            !confirmed || terminal ? null : new Date(Date.now() + LEASE_MS),
        })
        .where(eq(productionDatabaseProvisions.id, saved.id))
        .returning();
      if (!updated)
        throw new AppDatabaseError(
          503,
          "SQL phase acknowledgement could not be confirmed.",
        );
      return receipt(updated, false);
    }),
  );
}
