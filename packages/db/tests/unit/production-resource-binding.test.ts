import { expect, test } from "bun:test";
import {
  parseProductionResourceBinding,
  ProductionOperationPrincipal,
} from "../../src/application-databases/production-cluster/resource-contract";
const resourceId = crypto.randomUUID();
const binding = {
  version: "1",
  provider: "postgres-cluster",
  connectionId: crypto.randomUUID(),
  clusterId: "123456789",
  database: `wrenly_${resourceId.replaceAll("-", "")}`,
  networkId: "a".repeat(64),
};
test("remote bindings cannot alias another project or impersonate a local Docker database", () => {
  expect(parseProductionResourceBinding(resourceId, binding).connectionId).toBe(
    binding.connectionId,
  );
  expect(() =>
    parseProductionResourceBinding(crypto.randomUUID(), binding),
  ).toThrow();
  expect(() =>
    parseProductionResourceBinding(resourceId, {
      ...binding,
      provider: "local",
    }),
  ).toThrow();
  expect(() =>
    parseProductionResourceBinding(resourceId, {
      ...binding,
      containerId: "b".repeat(64),
    }),
  ).toThrow();
});
test("Production execution requires a complete bounded session and access snapshot", () => {
  const principal = {
    userId: "owner",
    sessionId: "current-session",
    revision: crypto.randomUUID(),
    accessRevision: crypto.randomUUID(),
  };
  expect(ProductionOperationPrincipal.safeParse(principal).success).toBe(true);
  for (const value of [
    null,
    { ...principal, accessRevision: undefined },
    { ...principal, revision: "stale" },
    { ...principal, sessionId: "" },
  ])
    expect(ProductionOperationPrincipal.safeParse(value).success).toBe(false);
});
