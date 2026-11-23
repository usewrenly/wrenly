import { expect, test } from "bun:test";
import {
  ProductionMaintenanceGrant,
  assessProductionMaintenance,
  type ProductionMaintenanceEvidence,
} from "../../src/application-databases/maintenance/contract";
import {
  acknowledgeProductionPublishingEffect,
  beginProductionPublishingEffect,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "../../src/application-databases/production-publishing-contract";

function fixture(): {
  grant: ProductionMaintenanceGrant;
  current: ProductionMaintenanceEvidence;
} {
  const binding: ProductionPublishingBinding = {
    version: 1,
    deploymentId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    buildId: crypto.randomUUID(),
    resourceId: crypto.randomUUID(),
    resourceRevision: crypto.randomUUID(),
    sourceSha256: "a".repeat(64),
    schemaDigest: "b".repeat(64),
    migrationDigest: "c".repeat(64),
    connectionId: crypto.randomUUID(),
    clusterId: "123",
    hostConnectionId: crypto.randomUUID(),
    dockerId: "test-daemon",
    serverId: "test-server",
    principal: {
      userId: "owner",
      sessionId: "original-publishing-session",
      revision: crypto.randomUUID(),
      accessRevision: crypto.randomUUID(),
    },
  };
  const image = `sha256:${"d".repeat(64)}`,
    now = new Date("2026-11-12T09:00:00.000Z");
  const facts = [
    {
      step: "http-volume",
      name: `wrenly-deployment-http-${binding.deploymentId}`,
      createdAt: now.toISOString(),
    },
    {
      step: "database-volume",
      name: `wrenly-deployment-db-${binding.deploymentId}`,
      createdAt: now.toISOString(),
    },
    { step: "broker-network", networkId: "e".repeat(64) },
    {
      step: "broker-start",
      containerId: "f".repeat(64),
      imageId: image,
      networkId: "e".repeat(64),
      volumeName: `wrenly-deployment-db-${binding.deploymentId}`,
    },
    {
      step: "service-create",
      serviceId: "service",
      compositionSha256: "1".repeat(64),
      appImageId: image,
      appRegistryDigest: image,
      ingressRegistryDigest: image,
    },
    { step: "service-start", serviceId: "service" },
    { step: "application-start", containerId: "2".repeat(64), imageId: image },
    {
      step: "route-verify",
      url: "https://test.example.test/",
      sourceSha256: binding.sourceSha256,
    },
  ];
  const token = crypto.randomUUID();
  let publication: ProductionPublishingJournal = {
    version: 1,
    pending: null,
    completed: [],
  };
  for (const fact of facts) {
    publication = beginProductionPublishingEffect(
      binding,
      publication,
      token,
      now,
    );
    publication = acknowledgeProductionPublishingEffect(
      binding,
      publication,
      { effect: publication.pending, fact, completedAt: now.toISOString() },
      token,
    );
  }
  const grant = ProductionMaintenanceGrant.parse({
    version: 1,
    id: crypto.randomUUID(),
    revision: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    state: "enabled",
    confirmedAt: new Date(now.getTime() + 1000).toISOString(),
    confirmMaintenance: true,
    confirmedBy: { ...binding.principal, sessionId: "new-confirming-session" },
    binding,
    publication,
  });
  return {
    grant,
    current: {
      grantRevision: grant.revision,
      ownerId: "owner",
      ownerRevision: grant.confirmedBy.revision,
      ownerActive: true,
      projectAccessRevision: binding.principal.accessRevision,
      projectArchived: false,
      resourceRevision: binding.resourceRevision,
      resourceReady: true,
      schemaDigest: binding.schemaDigest,
      connectionId: binding.connectionId,
      clusterId: binding.clusterId,
      hostConnectionId: binding.hostConnectionId,
      hostVerified: true,
      dockerId: binding.dockerId,
      serverId: binding.serverId,
      conflictingWork: false,
      publicationStatus: "success",
      binding: structuredClone(binding),
      publication: structuredClone(publication),
    },
  };
}

test("a separate confirmed permission does not depend on the original publishing session", () => {
  const { grant, current } = fixture();
  expect(grant.confirmedBy.sessionId).not.toBe(
    grant.binding.principal.sessionId,
  );
  expect(assessProductionMaintenance(grant, current)).toEqual({
    allowed: true,
  });
  expect(
    assessProductionMaintenance(
      { ...grant, confirmMaintenance: false },
      current,
    ),
  ).toEqual({ allowed: false, reason: "invalid-evidence" });
});

test("paused, revoked or replaced grant revisions cannot authorize maintenance", () => {
  const { grant, current } = fixture();
  for (const state of ["paused", "revoked"] as const)
    expect(assessProductionMaintenance({ ...grant, state }, current)).toEqual({
      allowed: false,
      reason: "permission-inactive",
    });
  expect(
    assessProductionMaintenance(grant, {
      ...current,
      grantRevision: crypto.randomUUID(),
    }),
  ).toEqual({ allowed: false, reason: "permission-inactive" });
});

test("live account, project, resource and host changes fail closed", () => {
  const { grant, current } = fixture();
  const cases: Array<[Partial<ProductionMaintenanceEvidence>, string]> = [
    [{ ownerActive: false }, "owner-changed"],
    [{ ownerId: "different-owner" }, "owner-changed"],
    [{ ownerRevision: crypto.randomUUID() }, "owner-changed"],
    [{ projectArchived: true }, "project-changed"],
    [{ projectAccessRevision: crypto.randomUUID() }, "project-changed"],
    [{ resourceReady: false }, "resource-changed"],
    [{ resourceRevision: crypto.randomUUID() }, "resource-changed"],
    [{ schemaDigest: "9".repeat(64) }, "resource-changed"],
    [{ connectionId: crypto.randomUUID() }, "resource-changed"],
    [{ clusterId: "456" }, "resource-changed"],
    [{ hostVerified: false }, "host-changed"],
    [{ hostConnectionId: crypto.randomUUID() }, "host-changed"],
    [{ dockerId: "replacement-daemon" }, "host-changed"],
    [{ serverId: "replacement-server" }, "host-changed"],
    [{ publicationStatus: "interrupted" }, "publication-changed"],
    [{ conflictingWork: true }, "conflicting-work"],
  ];
  for (const [change, reason] of cases)
    expect(
      assessProductionMaintenance(grant, { ...current, ...change }),
    ).toEqual({ allowed: false, reason });
});

test("incomplete, substituted or secret-bearing publication evidence is refused", () => {
  const { grant, current } = fixture();
  const incomplete = structuredClone(grant.publication);
  incomplete.completed.pop();
  expect(
    ProductionMaintenanceGrant.safeParse({ ...grant, publication: incomplete })
      .success,
  ).toBe(false);
  expect(
    ProductionMaintenanceGrant.safeParse({
      ...grant,
      confirmedAt: "2026-11-11T00:00:00.000Z",
    }).success,
  ).toBe(false);
  expect(
    ProductionMaintenanceGrant.safeParse({
      ...grant,
      confirmedBy: { ...grant.confirmedBy, userId: "other" },
    }).success,
  ).toBe(false);
  expect(
    ProductionMaintenanceGrant.safeParse({
      ...grant,
      password: "must-not-store",
    }).success,
  ).toBe(false);
  const substituted = structuredClone(current.publication);
  const app = substituted.completed.find(
    (row) => row.fact.step === "application-start",
  )!;
  if (app.fact.step === "application-start")
    app.fact.containerId = "8".repeat(64);
  expect(
    assessProductionMaintenance(grant, {
      ...current,
      publication: substituted,
    }),
  ).toEqual({ allowed: false, reason: "publication-changed" });
  expect(
    assessProductionMaintenance(grant, {
      ...current,
      sessionId: "browser-assertion",
    }),
  ).toEqual({ allowed: false, reason: "invalid-evidence" });
});
