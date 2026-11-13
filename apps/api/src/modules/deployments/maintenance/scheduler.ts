/** Bounded server polling uses saved owner permission; it never retries an unfinished attempt. */
import { asc, desc, eq, gt } from "drizzle-orm";
import {
  type db,
  productionRuntimeMaintenance,
  productionRuntimeMaintenanceAttempts,
} from "@wrenly/db";
import { ProductionMaintenanceGrant } from "@wrenly/db/production-maintenance-contract";
import { MaintenanceAttempt } from "@wrenly/db/production-maintenance-attempt";
import { claimMaintenance, type MaintenanceClaim } from "./claims";
const PAGE_SIZE = 16;
export const MAINTENANCE_INTERVAL_MS = 60000;
export interface MaintenanceSchedulerServices {
  page: (
    after: string | null,
  ) => Promise<Array<{ deploymentId: string; revision: string }>>;
  claim: (
    deploymentId: string,
    revision: string,
  ) => Promise<MaintenanceClaim | null>;
  run: (claim: MaintenanceClaim, signal: AbortSignal) => Promise<void>;
  failed: () => void;
}
/** Keyset pages prevent unavailable older grants from starving later projects; reads alone admit no work. */
export function maintenanceScheduleStore(
  database: typeof db,
): Pick<MaintenanceSchedulerServices, "page" | "claim"> {
  return {
    page: async (after) => {
      const rows = await database
        .select()
        .from(productionRuntimeMaintenance)
        .where(
          after
            ? gt(productionRuntimeMaintenance.deploymentId, after)
            : undefined,
        )
        .orderBy(asc(productionRuntimeMaintenance.deploymentId))
        .limit(PAGE_SIZE);
      // Disabled entries still advance the cursor; their revision is empty and never claimed.
      return rows.map((row) => {
        const grant = ProductionMaintenanceGrant.parse(row.grant);
        return {
          deploymentId: row.deploymentId,
          revision: grant.state === "enabled" ? grant.revision : "",
        };
      });
    },
    claim: async (id, revision) => {
      const [latest] = await database
        .select()
        .from(productionRuntimeMaintenanceAttempts)
        .where(eq(productionRuntimeMaintenanceAttempts.deploymentId, id))
        .orderBy(
          desc(productionRuntimeMaintenanceAttempts.createdAt),
          desc(productionRuntimeMaintenanceAttempts.id),
        )
        .limit(1);
      if (
        latest &&
        (MaintenanceAttempt.parse(latest.journal).status !== "success" ||
          latest.updatedAt.getTime() + MAINTENANCE_INTERVAL_MS > Date.now())
      )
        return null;
      return claimMaintenance(database, id, revision, MAINTENANCE_INTERVAL_MS);
    },
  };
}
/** stop aborts owned work and waits for it; another process cannot replay its pending credential handoff. */
export function startMaintenanceScheduler(
  services: MaintenanceSchedulerServices,
  intervalMs = MAINTENANCE_INTERVAL_MS,
): { done: Promise<void>; stop: () => Promise<void> } {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1)
    throw new Error("Invalid maintenance interval.");
  const shutdown = new AbortController();
  const done = (async (): Promise<void> => {
    let after: string | null = null;
    while (!shutdown.signal.aborted) {
      try {
        const rows = await services.page(after);
        after = rows.length ? rows.at(-1)!.deploymentId : null;
        for (const row of rows) {
          if (shutdown.signal.aborted) break;
          if (!row.revision) continue;
          try {
            const claim = await services.claim(row.deploymentId, row.revision);
            if (claim) await services.run(claim, shutdown.signal);
          } catch {
            if (!shutdown.signal.aborted) services.failed();
          }
        }
      } catch {
        if (!shutdown.signal.aborted) services.failed();
      }
      if (!shutdown.signal.aborted)
        await new Promise<void>((resolve) => {
          const finish = (): void => {
            clearTimeout(timer);
            shutdown.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, intervalMs);
          shutdown.signal.addEventListener("abort", finish, { once: true });
          if (shutdown.signal.aborted) finish();
        });
    }
  })();
  return {
    done,
    stop: async () => {
      shutdown.abort();
      await done;
    },
  };
}
