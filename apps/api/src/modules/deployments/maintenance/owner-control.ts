/** Owner-confirmed Stop/inspection has its own journal; it never borrows a background grant to replay uncertain work. */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  type db,
  deployments,
  productionRuntimeMaintenance,
  productionRuntimeMaintenanceAttempts,
} from "@wrenly/db";
import {
  MaintenanceControl,
  MaintenanceControlReceipt,
  ProductionMaintenanceGrant,
} from "@wrenly/db/production-maintenance-contract";
import {
  STOP_MAINTENANCE_STEPS,
  INSPECT_MAINTENANCE_STEPS,
  MaintenanceAttempt,
  beginMaintenanceEffect,
  acknowledgeMaintenanceEffect,
} from "@wrenly/db/production-maintenance-attempt";
import {
  ProductionPublishingBinding,
  validateProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { acquireDeploymentExecutorLock } from "../execution/deployment-executor-lock";
import { DeploymentStoreError } from "../persistence/deployment-store";
import { lockMaintenanceOwner, verifyMaintenancePublication } from "./store";
const CONTROL_TIMEOUT_MS = 120_000;
const CONTROL_LEASE_MS = 30_000;
const RENEWAL_MS = 5000;
const MAX_ATTEMPTS = 1000;
const MAX_UNRESOLVED_ATTEMPTS = 16;
type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export interface OwnerRuntimeControlContext {
  grant: ProductionMaintenanceGrant;
  attempt: MaintenanceAttempt;
  signal: AbortSignal;
  assertHeld: () => Promise<void>;
  authorize: (tx: Transaction) => Promise<ProductionPublishingBinding>;
}
export interface OwnerRuntimeControlServices {
  perform: (
    input: OwnerRuntimeControlContext & {
      effect: NonNullable<MaintenanceAttempt["pending"]>;
    },
  ) => Promise<void>;
}
function receipt(
  journal: MaintenanceAttempt,
  replayed: boolean,
): MaintenanceControlReceipt {
  if (!journal.control)
    throw new DeploymentStoreError(404, "Runtime control not found.");
  return MaintenanceControlReceipt.parse({
    requestId: journal.id,
    kind: journal.control.kind,
    status:
      journal.status === "running" &&
      Date.parse(journal.leaseExpiresAt) <= Date.now()
        ? "interrupted"
        : journal.status,
    step: journal.pending?.step ?? null,
    replayed,
  });
}
/** Read-only status lookup cannot repeat a remote Stop or inspection. */
export async function readOwnerRuntimeControl(input: {
  database: Database;
  actor: AccessPrincipal;
  projectId: string;
  deploymentId: string;
  requestId: string;
}): Promise<MaintenanceControlReceipt | null> {
  return input.database.transaction(async (tx) => {
    await lockMaintenanceOwner(tx, input.projectId, input.actor);
    const [row] = await tx
      .select()
      .from(productionRuntimeMaintenanceAttempts)
      .where(eq(productionRuntimeMaintenanceAttempts.id, input.requestId));
    if (
      !row ||
      row.projectId !== input.projectId ||
      row.deploymentId !== input.deploymentId
    )
      return null;
    const journal = MaintenanceAttempt.parse(row.journal);
    if (journal.control?.actorId !== input.actor.userId) return null;
    return receipt(journal, true);
  });
}
/** Execution is owned by its bounded durable claim, not by the HTTP connection or browser. */
export async function runOwnerRuntimeControl(input: {
  database: Database;
  actor: AccessPrincipal;
  projectId: string;
  deploymentId: string;
  action: unknown;
  services: OwnerRuntimeControlServices;
}): Promise<MaintenanceControlReceipt> {
  const action = MaintenanceControl.parse(input.action),
    { database, actor, projectId, deploymentId } = input;
  const identity = createHash("sha256")
    .update(JSON.stringify([projectId, deploymentId, action]))
    .digest("hex");
  const replay = async (
    tx: Transaction,
  ): Promise<MaintenanceControlReceipt | null> => {
    const [row] = await tx
      .select()
      .from(productionRuntimeMaintenanceAttempts)
      .where(eq(productionRuntimeMaintenanceAttempts.id, action.requestId));
    if (!row) return null;
    const journal = MaintenanceAttempt.parse(row.journal);
    if (
      row.projectId !== projectId ||
      row.deploymentId !== deploymentId ||
      journal.control?.actorId !== actor.userId ||
      journal.control.requestIdentity !== identity
    )
      throw new DeploymentStoreError(
        409,
        "Runtime control request contains different reviewed values.",
      );
    return receipt(journal, true);
  };
  const previous = await database.transaction(async (tx) => {
    await lockMaintenanceOwner(tx, projectId, actor);
    return replay(tx);
  });
  if (previous) return previous;
  const token = crypto.randomUUID(),
    lock = await acquireDeploymentExecutorLock({ deploymentId, token });
  const signal = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
  let grant!: ProductionMaintenanceGrant, attempt!: MaintenanceAttempt;
  let admitted = false,
    renewing: Promise<void> | undefined;
  const originals = new Map<string, string>();
  try {
    const saved = await database.transaction(async (tx) => {
      const project = await lockMaintenanceOwner(tx, projectId, actor);
      const existing = await replay(tx);
      if (existing) return existing;
      const [permission] = await tx
        .select()
        .from(productionRuntimeMaintenance)
        .where(eq(productionRuntimeMaintenance.deploymentId, deploymentId))
        .for("update");
      const oldGrant = permission
        ? ProductionMaintenanceGrant.parse(permission.grant)
        : null;
      if (
        project.accessRevision !== action.expectedAccessRevision ||
        (oldGrant?.revision ?? null) !== action.expectedGrantRevision ||
        (permission && permission.projectId !== projectId)
      )
        throw new DeploymentStoreError(
          409,
          "Runtime control state changed. Reload and review it again.",
        );
      const [publication] = await tx
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.id, deploymentId),
            eq(deployments.projectId, projectId),
          ),
        );
      if (!publication || publication.status !== "success")
        throw new DeploymentStoreError(404, "Verified publication not found.");
      const binding =
        oldGrant?.binding ??
        ProductionPublishingBinding.parse(
          publication.productionDatabaseBinding,
        );
      grant = ProductionMaintenanceGrant.parse(
        oldGrant ?? {
          version: 1,
          id: crypto.randomUUID(),
          revision: crypto.randomUUID(),
          requestId: action.requestId,
          state: "paused",
          confirmedAt: new Date().toISOString(),
          confirmedBy: { ...actor, accessRevision: project.accessRevision },
          confirmMaintenance: true,
          binding,
          publication: validateProductionPublishingJournal(
            binding,
            publication.productionRuntimeJournal,
          ),
        },
      );
      const rows = await tx
        .select()
        .from(productionRuntimeMaintenanceAttempts)
        .where(eq(productionRuntimeMaintenanceAttempts.projectId, projectId))
        .limit(MAX_ATTEMPTS)
        .for("update");
      if (rows.length === MAX_ATTEMPTS)
        throw new DeploymentStoreError(
          409,
          "Runtime history needs inspection before another control action.",
        );
      for (const row of rows) {
        const journal = MaintenanceAttempt.parse(row.journal);
        if (["success", "reconciled"].includes(journal.status)) continue;
        if (
          row.deploymentId !== deploymentId ||
          (journal.status === "running" &&
            Date.parse(journal.leaseExpiresAt) > Date.now())
        )
          throw new DeploymentStoreError(
            409,
            "Another runtime operation is still active or needs review.",
          );
        originals.set(row.id, JSON.stringify(journal));
      }
      if (originals.size > MAX_UNRESOLVED_ATTEMPTS)
        throw new DeploymentStoreError(
          409,
          "Too many unresolved runtime attempts require inspection.",
        );
      await verifyMaintenancePublication(
        tx,
        grant,
        [...originals.keys()],
        true,
      );
      if (action.kind === "stop") {
        // Permission and Stop intent commit together, so no worker may undo this explicit owner choice.
        grant = ProductionMaintenanceGrant.parse({
          ...grant,
          revision: crypto.randomUUID(),
          requestId: action.requestId,
          state: grant.state === "revoked" ? "revoked" : "paused",
        });
        await tx
          .insert(productionRuntimeMaintenance)
          .values({ deploymentId, projectId, grant })
          .onConflictDoUpdate({
            target: productionRuntimeMaintenance.deploymentId,
            set: { grant, updatedAt: new Date() },
          });
      } else if (!oldGrant)
        throw new DeploymentStoreError(
          409,
          "No maintenance attempt exists to inspect.",
        );
      attempt = MaintenanceAttempt.parse({
        id: action.requestId,
        grantRevision: grant.revision,
        claimToken: token,
        leaseExpiresAt: new Date(Date.now() + CONTROL_LEASE_MS).toISOString(),
        status: "running",
        pending: null,
        completed: [],
        control: {
          kind: action.kind,
          actorId: actor.userId,
          sessionId: actor.sessionId,
          accountRevision: actor.revision,
          accessRevision: project.accessRevision,
          requestIdentity: identity,
          originals: [...originals.keys()],
        },
      });
      await tx
        .insert(productionRuntimeMaintenanceAttempts)
        .values({ id: attempt.id, projectId, deploymentId, journal: attempt });
      return null;
    });
    if (saved) return saved;
    admitted = true;
    const authorize = async (
      tx: Transaction,
    ): Promise<ProductionPublishingBinding> => {
      const project = await lockMaintenanceOwner(tx, projectId, actor);
      const [permission] = await tx
        .select()
        .from(productionRuntimeMaintenance)
        .where(eq(productionRuntimeMaintenance.deploymentId, deploymentId));
      const [row] = await tx
        .select()
        .from(productionRuntimeMaintenanceAttempts)
        .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id))
        .for("update");
      const current = MaintenanceAttempt.parse(row?.journal);
      if (
        project.accessRevision !== action.expectedAccessRevision ||
        !row ||
        row.projectId !== projectId ||
        row.deploymentId !== deploymentId ||
        current.status !== "running" ||
        current.claimToken !== token ||
        current.grantRevision !== grant.revision ||
        Date.parse(current.leaseExpiresAt) <= Date.now() ||
        JSON.stringify(current.control) !== JSON.stringify(attempt.control) ||
        JSON.stringify(ProductionMaintenanceGrant.parse(permission?.grant)) !==
          JSON.stringify(grant)
      )
        throw new DeploymentStoreError(
          409,
          "Runtime control authority, lease or permission changed.",
        );
      await verifyMaintenancePublication(
        tx,
        grant,
        [attempt.id, ...originals.keys()],
        true,
      );
      return grant.binding;
    };
    const assertHeld = async (): Promise<void> => {
      lock.assertHeld();
      signal.throwIfAborted();
      if (!renewing)
        renewing = database
          .transaction(async (tx) => {
            await authorize(tx);
            const [row] = await tx
              .select()
              .from(productionRuntimeMaintenanceAttempts)
              .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id));
            const current = MaintenanceAttempt.parse(row?.journal);
            await tx
              .update(productionRuntimeMaintenanceAttempts)
              .set({
                journal: {
                  ...current,
                  leaseExpiresAt: new Date(
                    Date.now() + CONTROL_LEASE_MS,
                  ).toISOString(),
                },
                updatedAt: new Date(),
              })
              .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id));
          })
          .finally(() => {
            renewing = undefined;
          });
      await renewing;
      lock.assertHeld();
      signal.throwIfAborted();
    };
    const timer = setInterval(() => {
      void assertHeld().catch(() => {
        /* Next effect refuses the lost claim. */
      });
    }, RENEWAL_MS);
    try {
      for (
        let index = 0;
        index <
        (action.kind === "stop"
          ? STOP_MAINTENANCE_STEPS
          : INSPECT_MAINTENANCE_STEPS
        ).length;
        index++
      ) {
        await assertHeld();
        attempt = await database.transaction(async (tx) => {
          await authorize(tx);
          const [row] = await tx
            .select()
            .from(productionRuntimeMaintenanceAttempts)
            .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id));
          const next = beginMaintenanceEffect(
            row!.journal,
            token,
            grant.revision,
            new Date(),
          );
          await tx
            .update(productionRuntimeMaintenanceAttempts)
            .set({ journal: next, updatedAt: new Date() })
            .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id));
          return next;
        });
        await input.services.perform({
          grant,
          attempt,
          effect: attempt.pending!,
          signal,
          assertHeld,
          authorize,
        });
        await assertHeld();
        attempt = await database.transaction(async (tx) => {
          await authorize(tx);
          const [row] = await tx
            .select()
            .from(productionRuntimeMaintenanceAttempts)
            .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id));
          const next = acknowledgeMaintenanceEffect(
            row!.journal,
            token,
            grant.revision,
            attempt.pending!.id,
            new Date(),
          );
          if (next.status === "success")
            for (const [id, evidence] of originals) {
              const [source] = await tx
                .select()
                .from(productionRuntimeMaintenanceAttempts)
                .where(eq(productionRuntimeMaintenanceAttempts.id, id))
                .for("update");
              if (
                !source ||
                source.deploymentId !== deploymentId ||
                source.projectId !== projectId ||
                JSON.stringify(MaintenanceAttempt.parse(source.journal)) !==
                  evidence
              )
                throw new DeploymentStoreError(
                  409,
                  "Original runtime evidence changed during inspection.",
                );
              await tx
                .update(productionRuntimeMaintenanceAttempts)
                .set({
                  journal: MaintenanceAttempt.parse({
                    ...source.journal,
                    status: "reconciled",
                    resolution: {
                      controlId: attempt.id,
                      outcome: action.kind === "stop" ? "stopped" : "ready",
                      verifiedAt: new Date().toISOString(),
                    },
                  }),
                  updatedAt: new Date(),
                })
                .where(eq(productionRuntimeMaintenanceAttempts.id, id));
            }
          await tx
            .update(productionRuntimeMaintenanceAttempts)
            .set({ journal: next, updatedAt: new Date() })
            .where(eq(productionRuntimeMaintenanceAttempts.id, attempt.id));
          return next;
        });
      }
      return receipt(attempt, false);
    } finally {
      clearInterval(timer);
      if (renewing) await renewing;
    }
  } catch (error) {
    if (admitted)
      await database
        .transaction(async (tx) => {
          await lockMaintenanceOwner(tx, projectId, actor);
          const [row] = await tx
            .select()
            .from(productionRuntimeMaintenanceAttempts)
            .where(
              eq(productionRuntimeMaintenanceAttempts.id, action.requestId),
            )
            .for("update");
          if (!row) return;
          const current = MaintenanceAttempt.parse(row.journal);
          if (current.status === "running" && current.claimToken === token)
            await tx
              .update(productionRuntimeMaintenanceAttempts)
              .set({
                journal: { ...current, status: "interrupted" },
                updatedAt: new Date(),
              })
              .where(eq(productionRuntimeMaintenanceAttempts.id, current.id));
        })
        .catch(() => {
          /* A lost session cannot dismiss the saved intent; lease expiry still exposes interruption. */
        });
    if (error instanceof DeploymentStoreError) throw error;
    throw new DeploymentStoreError(
      409,
      "Runtime control could not be confirmed. Check its saved action before doing anything again.",
    );
  } finally {
    await lock.release();
  }
}
