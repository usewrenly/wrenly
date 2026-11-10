/** Pure ordered executor: saved intent and acknowledgement surround each SQL call. */
import {
  PRODUCTION_PROVISION_PHASES,
  type ProductionProvisionPhase,
} from "@wrenly/db/production-project-credentials";
import type { ProjectProvisionClaim, ProjectProvisionReceipt } from "./store";
export interface ProjectProvisionExecution<PhaseInput> {
  assertHeld: () => void;
  begin: (
    claim: ProjectProvisionClaim,
    phase: ProductionProvisionPhase,
  ) => Promise<PhaseInput>;
  run: (phase: ProductionProvisionPhase, input: PhaseInput) => Promise<void>;
  finish: (
    claim: ProjectProvisionClaim,
    phase: ProductionProvisionPhase,
    confirmed: boolean,
  ) => Promise<ProjectProvisionReceipt>;
}
/** A lost acknowledgement throws immediately; neither this phase nor a following one runs again. */
export async function executeProjectProductionProvision<PhaseInput>(
  claim: ProjectProvisionClaim,
  dependencies: ProjectProvisionExecution<PhaseInput>,
  signal: AbortSignal,
): Promise<ProjectProvisionReceipt> {
  let receipt: ProjectProvisionReceipt | undefined;
  for (const phase of PRODUCTION_PROVISION_PHASES) {
    signal.throwIfAborted();
    dependencies.assertHeld();
    const saved = await dependencies.begin(claim, phase);
    let confirmed: boolean;
    try {
      signal.throwIfAborted();
      dependencies.assertHeld();
      await dependencies.run(phase, saved);
      confirmed = true;
    } catch {
      // Even a connection failure can hide completed SQL; recovery must inspect the phase.
      confirmed = false;
    }
    dependencies.assertHeld();
    receipt = await dependencies.finish(claim, phase, confirmed);
    if (!confirmed) return receipt;
  }
  if (!receipt)
    throw new Error("No Production provisioning phase was executed.");
  return receipt;
}
