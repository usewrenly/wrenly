/** Server-only wiring for a single claimed verification; startup does not enable it yet. */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { db } from "@wrenly/db";
import { inspectAuthenticatedProductionTarget } from "../authenticated-inspection";
import { pinProductionDatabaseTarget } from "../target-policy";
import { claimProductionSetup, loadProductionSetup, finishProductionSetupCheck, type ProductionSetupReceipt } from "./setup-store";
import { executeProductionVerification } from "./verification-executor";
const ControlIdentity = z.object({ cluster_id: z.string().regex(/^[0-9]{1,20}$/) });
/** Reads the control server's own immutable identity, never accepting that identity from the browser. */
export async function readControlIdentity(database: typeof db): Promise<string> {
  try {
    return await database.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(sql`set local statement_timeout = '5s'`);
      const rows = await tx.execute(sql`select system_identifier::text as cluster_id from pg_catalog.pg_control_system()`);
      if (rows.length !== 1) throw new Error("Missing control identity");
      return ControlIdentity.parse(rows[0]).cluster_id;
    });
  } catch {
    throw new Error("Control database identity could not be verified.");
  }
}
/** Takes at most one queued request. Callers must await shutdown; no automatic retries occur here. */
export async function runProductionVerificationOnce(input: {
  database: typeof db;
  directory: string;
  controlDatabaseUrl: string;
  signal?: AbortSignal;
}): Promise<ProductionSetupReceipt | null> {
  try {
    input.signal?.throwIfAborted();
    const claim = await claimProductionSetup(input.database);
    if (!claim) return null;
    return await executeProductionVerification(claim, {
      load: (current) => loadProductionSetup(input.database, current, input.directory),
      controlIdentity: () => readControlIdentity(input.database),
      pin: (target, signal) => pinProductionDatabaseTarget(target, input.controlDatabaseUrl, { signal }),
      inspect: (saved) => inspectAuthenticatedProductionTarget({ ...saved, controlDatabaseUrl: input.controlDatabaseUrl }),
      finish: (current, outcome) => finishProductionSetupCheck(input.database, current, outcome),
    }, input.signal);
  } catch {
    throw new Error("Production setup verification could not be confirmed. Review its saved status before continuing.");
  }
}
