import { expect, test } from "bun:test";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  validateProductionPublishingJournal,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "../../src/application-databases/production-publishing-contract";
function binding(): ProductionPublishingBinding {
  return {
    version: 1,
    deploymentId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    buildId: crypto.randomUUID(),
    sourceSha256: "a".repeat(64),
    resourceId: crypto.randomUUID(),
    resourceRevision: crypto.randomUUID(),
    schemaDigest: "b".repeat(64),
    migrationDigest: "c".repeat(64),
    connectionId: crypto.randomUUID(),
    clusterId: "123",
    hostConnectionId: crypto.randomUUID(),
    dockerId: "fixture-daemon",
    serverId: "fixture-server",
    principal: {
      userId: "owner",
      sessionId: "session",
      revision: crypto.randomUUID(),
      accessRevision: crypto.randomUUID(),
    },
  };
}
const image = `sha256:${"d".repeat(64)}`;
test("Production publishing advances only after exact ordered acknowledgements", () => {
  const saved = binding(),
    token = crypto.randomUUID(),
    now = new Date();
  let journal: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  const facts = [
    {
      step: "http-volume",
      name: `wrenly-deployment-http-${saved.deploymentId}`,
      createdAt: now.toISOString(),
    },
    {
      step: "database-volume",
      name: `wrenly-deployment-db-${saved.deploymentId}`,
      createdAt: now.toISOString(),
    },
    { step: "broker-network", networkId: "e".repeat(64) },
    {
      step: "broker-start",
      containerId: "f".repeat(64),
      imageId: image,
      networkId: "e".repeat(64),
      volumeName: `wrenly-deployment-db-${saved.deploymentId}`,
    },
    {
      step: "service-create",
      serviceId: "service",
      compositionSha256: "1".repeat(64),
      appImageId: image,
      appRegistryDigest: image,
      ingressRegistryDigest: `sha256:${"2".repeat(64)}`,
    },
    { step: "service-start", serviceId: "service" },
    { step: "application-start", containerId: "3".repeat(64), imageId: image },
    {
      step: "route-verify",
      url: "https://app.example.test/",
      sourceSha256: saved.sourceSha256,
    },
  ];
  for (const fact of facts) {
    journal = beginProductionPublishingEffect(saved, journal, token, now);
    expect(journal.pending?.step).toBe(fact.step);
    expect(() =>
      beginProductionPublishingEffect(saved, journal, token, now),
    ).toThrow("reconciliation");
    const receipt = {
      effect: journal.pending,
      fact,
      completedAt: now.toISOString(),
    };
    expect(() =>
      acknowledgeProductionPublishingEffect(
        saved,
        journal,
        receipt,
        crypto.randomUUID(),
      ),
    ).toThrow("owns its intent");
    journal = acknowledgeProductionPublishingEffect(
      saved,
      journal,
      receipt,
      token,
    );
  }
  expect(journal.completed).toHaveLength(8);
  expect(() =>
    beginProductionPublishingEffect(saved, journal, token, now),
  ).toThrow("already complete");
  const changed = structuredClone(journal);
  changed.completed[5]!.fact = { step: "service-start", serviceId: "foreign" };
  expect(() => validateProductionPublishingJournal(saved, changed)).toThrow(
    "service acknowledgement",
  );
});
test("changed volume identities, extra secret fields and stale intents cannot clear the journal", () => {
  const saved = binding(),
    token = crypto.randomUUID(),
    now = new Date(),
    journal = beginProductionPublishingEffect(
      saved,
      { version: 1, pending: null, completed: [] },
      token,
      now,
    );
  const receipt = {
    effect: journal.pending,
    fact: {
      step: "http-volume",
      name: "foreign",
      createdAt: now.toISOString(),
    },
    completedAt: now.toISOString(),
  };
  expect(() =>
    acknowledgeProductionPublishingEffect(saved, journal, receipt, token),
  ).toThrow("volume changed");
  expect(() =>
    acknowledgeProductionPublishingEffect(
      saved,
      journal,
      { ...receipt, effect: { ...journal.pending, id: crypto.randomUUID() } },
      token,
    ),
  ).toThrow("owns its intent");
  expect(() =>
    validateProductionPublishingJournal(
      { ...saved, password: "secret" },
      journal,
    ),
  ).toThrow();
  expect(() =>
    validateProductionPublishingJournal(saved, {
      ...journal,
      pending: { ...journal.pending, step: "application-start" },
    }),
  ).toThrow("pending effect changed");
  expect(journal.completed).toHaveLength(0);
  expect(journal.pending).not.toBeNull();
});
