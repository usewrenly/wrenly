/** Explicit Production resource worker factory; provider claims never fall back to the local adapter. */
import type { db } from "@wrenly/db";
import { logger } from "../../../../lib/logger";
import { startDatabaseWorker } from "../../database-worker";
import {
  claimDatabaseAction,
  renewDatabaseAction,
  interruptExpiredDatabaseActions,
  interruptDatabaseAction,
} from "../../database-store";
import { executeProductionResourceCreation } from "../project-provisioning/resource-worker";
import { loadProductionResourceExecution } from "../project-provisioning/resource-store";
import { executeProductionResourceMigrations } from "./migrations";
import { executeProductionResourceBackup } from "./backup";
/** The host must own/await stop; construction is deliberately separate from module startup activation. */
export function createProductionClusterResourceWorker(input: {
  database: typeof db;
  directory: string;
  controlDatabaseUrl: string;
}): { stop: () => Promise<void> } {
  return startDatabaseWorker({
    claim: () => claimDatabaseAction(input.database, "postgres-cluster"),
    renew: (claim) => renewDatabaseAction(input.database, claim),
    recoverExpired: () => interruptExpiredDatabaseActions(input.database),
    interrupt: (claim) => interruptDatabaseAction(input.database, claim),
    log: (message, context) => logger.info(message, context),
    execute: async (claim, signal) => {
      const saved = await loadProductionResourceExecution(
        input.database,
        claim,
        input.directory,
      );
      const context = { ...input, claim, signal };
      if (saved.operation.kind === "create")
        return executeProductionResourceCreation(context);
      if (saved.operation.kind === "backup")
        return executeProductionResourceBackup(context);
      if (saved.operation.kind === "migrate")
        return executeProductionResourceMigrations(context);
      throw new Error(
        "This saved Production action requires its own verified adapter.",
      );
    },
  });
}
