import { expect, test } from "bun:test";
import {
  executeMaintenance,
  type MaintenanceExecutionServices,
} from "./executor";
import {
  beginMaintenanceEffect,
  acknowledgeMaintenanceEffect,
  type MaintenanceAttempt,
} from "@wrenly/db/production-maintenance-attempt";
import type { ProductionMaintenanceGrant } from "@wrenly/db/production-maintenance-contract";
// Full grant validation belongs to the store; this fixture exercises the coordinator's revision and effect sequencing.
function fixture(): {
  services: MaintenanceExecutionServices;
  calls: string[];
  read: () => MaintenanceAttempt;
} {
  const revision = crypto.randomUUID(),
    token = crypto.randomUUID();
  let attempt: MaintenanceAttempt = {
    id: crypto.randomUUID(),
    grantRevision: revision,
    claimToken: token,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
    status: "running",
    pending: null,
    completed: [],
  };
  const grant = { revision, state: "enabled" } as ProductionMaintenanceGrant;
  const calls: string[] = [];
  const services: MaintenanceExecutionServices = {
    load: async () => ({
      grant: structuredClone(grant),
      attempt: structuredClone(attempt),
    }),
    assertHeld: async () => {},
    begin: async () => {
      attempt = beginMaintenanceEffect(attempt, token, revision, new Date());
      return structuredClone(attempt);
    },
    acknowledge: async (id) => {
      attempt = acknowledgeMaintenanceEffect(
        attempt,
        token,
        revision,
        id,
        new Date(),
      );
      return structuredClone(attempt);
    },
    perform: async ({ effect }) => {
      expect(attempt.pending?.id).toBe(effect.id);
      calls.push(effect.step);
    },
  };
  return { services, calls, read: () => attempt };
}
test("performs only saved maintenance effects in order", async () => {
  const f = fixture();
  await executeMaintenance(f.services, new AbortController().signal);
  expect(f.calls).toEqual([
    "broker-start",
    "application-start",
    "route-verify",
  ]);
  expect(f.read().status).toBe("success");
});
test("lost remote response preserves its intent and never repeats delivery", async () => {
  const f = fixture();
  f.services.perform = async ({ effect }) => {
    f.calls.push(effect.step);
    throw new Error("lost reply");
  };
  await expect(
    executeMaintenance(f.services, new AbortController().signal),
  ).rejects.toThrow("Inspect");
  const pending = structuredClone(f.read().pending);
  await expect(
    executeMaintenance(f.services, new AbortController().signal),
  ).rejects.toThrow("Inspect");
  expect(f.calls).toEqual(["broker-start"]);
  expect(f.read().pending).toEqual(pending);
});
test("revocation or lost lock before the effect prevents external execution", async () => {
  const f = fixture();
  let loads = 0;
  const load = f.services.load;
  f.services.load = async () => {
    const state = await load();
    if (++loads === 2) state.grant.state = "revoked";
    return state;
  };
  await expect(
    executeMaintenance(f.services, new AbortController().signal),
  ).rejects.toThrow("Inspect");
  expect(f.calls).toHaveLength(0);
  const g = fixture();
  g.services.assertHeld = async () => {
    throw new Error("lost lock");
  };
  await expect(
    executeMaintenance(g.services, new AbortController().signal),
  ).rejects.toThrow("Inspect");
  expect(g.calls).toHaveLength(0);
});
