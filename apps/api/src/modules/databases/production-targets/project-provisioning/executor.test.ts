/** Verifies SQL is never repeated after uncertainty or a lost durable acknowledgement. */
import { expect, test } from "bun:test";
import {
  PRODUCTION_PROVISION_PHASES,
  type ProductionProvisionPhase,
} from "@wrenly/db/production-project-credentials";
import {
  executeProjectProductionProvision,
  type ProjectProvisionExecution,
} from "./executor";
import type { ProjectProvisionClaim } from "./store";
const claim: ProjectProvisionClaim = {
  id: crypto.randomUUID(),
  projectId: crypto.randomUUID(),
  token: crypto.randomUUID(),
  principal: {
    userId: "fixture",
    sessionId: "fixture",
    revision: crypto.randomUUID(),
  },
};
function fixture(failure?: "sql" | "ack" | "intent") {
  const calls: string[] = [];
  const completed: ProductionProvisionPhase[] = [];
  const dependencies: ProjectProvisionExecution<{
    phase: ProductionProvisionPhase;
  }> = {
    assertHeld: () => {},
    begin: async (_, phase) => {
      calls.push(`intent:${phase}`);
      if (failure === "intent") throw new Error("Unknown intent");
      return { phase };
    },
    run: async (phase) => {
      calls.push(`sql:${phase}`);
      if (failure === "sql" && phase === "database")
        throw new Error("Unknown SQL response");
    },
    finish: async (_, phase, confirmed) => {
      calls.push(`ack:${phase}:${confirmed}`);
      if (failure === "ack") throw new Error("Unknown saved acknowledgement");
      if (confirmed) completed.push(phase);
      return {
        resourceId: claim.id,
        status: !confirmed
          ? "needs_review"
          : phase === "schema"
            ? "created"
            : "creating",
        completedPhases: [...completed],
        replayed: false,
      };
    },
  };
  return { calls, dependencies };
}
test("each phase has intent, SQL then acknowledgement in the approved order", async () => {
  const { calls, dependencies } = fixture();
  const result = await executeProjectProductionProvision(
    claim,
    dependencies,
    new AbortController().signal,
  );
  expect(calls).toEqual(
    PRODUCTION_PROVISION_PHASES.flatMap((phase) => [
      `intent:${phase}`,
      `sql:${phase}`,
      `ack:${phase}:true`,
    ]),
  );
  expect(result.status).toBe("created");
  expect(result.completedPhases).toEqual([...PRODUCTION_PROVISION_PHASES]);
});
test("uncertain SQL stops before the next phase and preserves its failed acknowledgement", async () => {
  const { calls, dependencies } = fixture("sql");
  const result = await executeProjectProductionProvision(
    claim,
    dependencies,
    new AbortController().signal,
  );
  expect(result.status).toBe("needs_review");
  expect(result.completedPhases).toEqual(["roles"]);
  expect(calls.filter((value) => value === "sql:database")).toHaveLength(1);
  expect(calls).not.toContain("intent:connections");
  expect(calls).toContain("ack:database:false");
});
test("lost intent or acknowledgement never becomes a second SQL call", async () => {
  for (const failure of ["intent", "ack"] as const) {
    const { calls, dependencies } = fixture(failure);
    await expect(
      executeProjectProductionProvision(
        claim,
        dependencies,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(calls.filter((value) => value.startsWith("sql:"))).toHaveLength(
      failure === "intent" ? 0 : 1,
    );
    expect(calls).not.toContain("intent:database");
  }
});
