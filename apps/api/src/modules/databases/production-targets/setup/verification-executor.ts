/** Executes one saved connection check; saving its outcome never provisions a database. */
import type { ProductionDatabaseInspection } from "@wrenly/db/production-database-inspection";
import type { ProductionSetupClaim, ProductionSetupReceipt } from "./setup-store";
import type { ProductionDatabaseTarget } from "@wrenly/db/production-database-target-contract";
import type { PinnedProductionTarget } from "../target-policy";
export interface ProductionVerificationDependencies {
  load: (claim: ProductionSetupClaim) => Promise<{ target: ProductionDatabaseTarget; credential: { user: string; password: string }; certificateAuthority?: string }>;
  controlIdentity: () => Promise<string>;
  pin: (target: ProductionDatabaseTarget, signal: AbortSignal) => Promise<PinnedProductionTarget>;
  inspect: (input: { target: PinnedProductionTarget; credential: { user: string; password: string }; certificateAuthority?: string; controlClusterId: string; signal: AbortSignal }) => Promise<ProductionDatabaseInspection>;
  finish: (claim: ProductionSetupClaim, outcome: { status: "verified"; inspection: ProductionDatabaseInspection } | { status: "refused" | "interrupted" }) => Promise<ProductionSetupReceipt>;
}
const VERIFICATION_DEADLINE_MS = 30_000;
/** A lost completion acknowledgement must be read back, never converted into another execution. */
export async function executeProductionVerification(
  claim: ProductionSetupClaim,
  dependencies: ProductionVerificationDependencies,
  cancellation?: AbortSignal,
): Promise<ProductionSetupReceipt> {
  const signal = AbortSignal.any([AbortSignal.timeout(VERIFICATION_DEADLINE_MS), ...(cancellation ? [cancellation] : [])]);
  let outcome: Parameters<ProductionVerificationDependencies["finish"]>[1];
  try {
    signal.throwIfAborted();
    const saved = await dependencies.load(claim);
    const controlClusterId = await dependencies.controlIdentity();
    signal.throwIfAborted();
    const target = await dependencies.pin(saved.target, signal);
    const inspection = await dependencies.inspect({ ...saved, target, controlClusterId, signal });
    signal.throwIfAborted();
    outcome = { status: "verified", inspection };
  } catch {
    outcome = { status: signal.aborted ? "interrupted" : "refused" };
  }
  // Keep persistence outside the remote-check catch: a failed acknowledgement is
  // unknown saved state, not evidence that authentication was refused.
  try {
    return await dependencies.finish(claim, outcome);
  } catch {
    throw new Error("Production verification completion could not be confirmed. Read the saved setup status before continuing.");
  }
}
