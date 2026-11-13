/** Executes only separately persisted maintenance intents; unknown replies remain pending. */
import {
  MaintenanceAttempt,
  MAINTENANCE_STEPS,
} from "@wrenly/db/production-maintenance-attempt";
import type { ProductionMaintenanceGrant } from "@wrenly/db/production-maintenance-contract";
export interface MaintenanceExecutionServices {
  load: () => Promise<{
    grant: ProductionMaintenanceGrant;
    attempt: MaintenanceAttempt;
  }>;
  begin: () => Promise<MaintenanceAttempt>;
  acknowledge: (effectId: string) => Promise<MaintenanceAttempt>;
  assertHeld: () => Promise<void>;
  /** Inspect exact saved identities and verify readiness. Never recreate a missing resource or replay an uncertain handoff. */
  perform: (input: {
    grant: ProductionMaintenanceGrant;
    effect: NonNullable<MaintenanceAttempt["pending"]>;
    signal: AbortSignal;
  }) => Promise<void>;
}
/** Caller retains the kernel lock and renewing claim throughout; no browser subscription owns execution. */
export async function executeMaintenance(
  services: MaintenanceExecutionServices,
  signal: AbortSignal,
): Promise<void> {
  try {
    for (let index = 0; index < MAINTENANCE_STEPS.length; index++) {
      signal.throwIfAborted();
      await services.assertHeld();
      const saved = await services.load(),
        before = MaintenanceAttempt.parse(saved.attempt);
      if (
        before.pending ||
        before.status !== "running" ||
        before.grantRevision !== saved.grant.revision ||
        saved.grant.state !== "enabled"
      )
        throw new Error("Maintenance needs review.");
      const intent = MaintenanceAttempt.parse(await services.begin());
      if (
        !intent.pending ||
        intent.id !== before.id ||
        intent.claimToken !== before.claimToken ||
        intent.grantRevision !== before.grantRevision ||
        JSON.stringify(intent.completed) !== JSON.stringify(before.completed)
      )
        throw new Error("Maintenance intent changed.");
      signal.throwIfAborted();
      await services.assertHeld();
      const current = await services.load();
      // Renewing ownership changes only the lease timestamp; it must not look like
      // a changed effect or authorize different pending/completed work.
      const currentAttempt = MaintenanceAttempt.parse(current.attempt);
      const { leaseExpiresAt: _currentLease, ...currentIdentity } =
        currentAttempt;
      const { leaseExpiresAt: _intentLease, ...intentIdentity } = intent;
      void _currentLease;
      void _intentLease;
      if (
        JSON.stringify(currentIdentity) !== JSON.stringify(intentIdentity) ||
        JSON.stringify(current.grant) !== JSON.stringify(saved.grant)
      )
        throw new Error("Maintenance permission or saved intent changed.");
      await services.perform({
        grant: current.grant,
        effect: intent.pending,
        signal,
      });
      signal.throwIfAborted();
      await services.assertHeld();
      const result = MaintenanceAttempt.parse(
        await services.acknowledge(intent.pending.id),
      );
      if (
        result.id !== before.id ||
        result.pending ||
        result.completed.length !== before.completed.length + 1 ||
        result.completed.at(-1)?.id !== intent.pending.id
      )
        throw new Error("Maintenance acknowledgement was not saved.");
      if (result.status === "success") return;
    }
    throw new Error("Maintenance exceeded its step budget.");
  } catch {
    throw new Error(
      "Maintenance could not be confirmed. Inspect its saved attempt before another restart; no automatic replay was requested.",
    );
  }
}
