/** Non-secret publishing snapshots and remote-effect receipts. Runtime credentials never enter this contract. */
import { z } from "zod";
import { ProductionOperationPrincipal } from "./production-cluster/resource-contract";
import { ProductionRuntimeHostIdentity } from "./production-host-contract";
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const DockerId = Hash;
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const RemoteId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+$/);
/** Admission freezes this after proving source, applied schema and host placement under the shared locks. */
export const ProductionPublishingBinding = z
  .object({
    version: z.literal(1),
    deploymentId: z.uuid(),
    projectId: z.uuid(),
    buildId: z.uuid(),
    sourceSha256: Hash,
    resourceId: z.uuid(),
    resourceRevision: z.uuid(),
    schemaDigest: Hash,
    migrationDigest: Hash,
    connectionId: z.uuid(),
    clusterId: z.string().regex(/^[0-9]{1,20}$/),
    hostConnectionId: z.uuid(),
    dockerId: ProductionRuntimeHostIdentity.shape.dockerId,
    serverId: RemoteId,
    principal: ProductionOperationPrincipal,
  })
  .strict();
export type ProductionPublishingBinding = z.infer<
  typeof ProductionPublishingBinding
>;
export const PRODUCTION_PUBLISHING_STEPS = [
  "http-volume",
  "database-volume",
  "broker-network",
  "broker-start",
  "service-create",
  "service-start",
  "application-start",
  "route-verify",
] as const;
export const ProductionPublishingStep = z.enum(PRODUCTION_PUBLISHING_STEPS);
export const ProductionPublishingEffect = z
  .object({
    id: z.uuid(),
    step: ProductionPublishingStep,
    claimToken: z.uuid(),
    startedAt: z.iso.datetime(),
  })
  .strict();
const Fact = z.discriminatedUnion("step", [
  z
    .object({
      step: z.literal("http-volume"),
      name: z.string().max(128),
      createdAt: z.string().min(1).max(64),
    })
    .strict(),
  z
    .object({
      step: z.literal("database-volume"),
      name: z.string().max(128),
      createdAt: z.string().min(1).max(64),
    })
    .strict(),
  z.object({ step: z.literal("broker-network"), networkId: DockerId }).strict(),
  z
    .object({
      step: z.literal("broker-start"),
      containerId: DockerId,
      imageId: ImageId,
      networkId: DockerId,
      volumeName: z.string().max(128),
    })
    .strict(),
  z
    .object({
      step: z.literal("service-create"),
      serviceId: RemoteId,
      compositionSha256: Hash,
      appImageId: ImageId,
      appRegistryDigest: ImageId,
      ingressRegistryDigest: ImageId,
    })
    .strict(),
  z.object({ step: z.literal("service-start"), serviceId: RemoteId }).strict(),
  z
    .object({
      step: z.literal("application-start"),
      containerId: DockerId,
      imageId: ImageId,
    })
    .strict(),
  z
    .object({
      step: z.literal("route-verify"),
      url: z.url().max(2048),
      sourceSha256: Hash,
    })
    .strict(),
]);
export const ProductionPublishingReceipt = z
  .object({
    effect: ProductionPublishingEffect,
    fact: Fact,
    completedAt: z.iso.datetime(),
  })
  .strict();
export const ProductionPublishingJournal = z
  .object({
    version: z.literal(1),
    pending: ProductionPublishingEffect.nullable(),
    completed: z
      .array(ProductionPublishingReceipt)
      .max(PRODUCTION_PUBLISHING_STEPS.length),
  })
  .strict();
export type ProductionPublishingJournal = z.infer<
  typeof ProductionPublishingJournal
>;
/** Checks persisted order and resource relationships before execution or acknowledging another effect. */
export function validateProductionPublishingJournal(
  binding_: unknown,
  journal_: unknown,
): ProductionPublishingJournal {
  const binding = ProductionPublishingBinding.parse(binding_),
    journal = ProductionPublishingJournal.parse(journal_);
  const ids = new Set<string>();
  for (let index = 0; index < journal.completed.length; index++) {
    const receipt = journal.completed[index]!;
    if (
      receipt.effect.step !== PRODUCTION_PUBLISHING_STEPS[index] ||
      receipt.fact.step !== receipt.effect.step ||
      ids.has(receipt.effect.id) ||
      Date.parse(receipt.completedAt) < Date.parse(receipt.effect.startedAt)
    )
      throw new Error("Production publishing effect order changed.");
    ids.add(receipt.effect.id);
    const fact = receipt.fact;
    if (
      (fact.step === "http-volume" &&
        fact.name !== `wrenly-deployment-http-${binding.deploymentId}`) ||
      (fact.step === "database-volume" &&
        fact.name !== `wrenly-deployment-db-${binding.deploymentId}`)
    )
      throw new Error("Production publishing volume changed.");
    if (fact.step === "broker-start") {
      const network = journal.completed[2]?.fact;
      if (
        network?.step !== "broker-network" ||
        fact.networkId !== network.networkId ||
        fact.volumeName !== `wrenly-deployment-db-${binding.deploymentId}`
      )
        throw new Error("Production broker acknowledgement changed.");
    }
    if (fact.step === "service-start") {
      const service = journal.completed[4]?.fact;
      if (
        service?.step !== "service-create" ||
        fact.serviceId !== service.serviceId
      )
        throw new Error("Production service acknowledgement changed.");
    }
    if (fact.step === "application-start") {
      const service = journal.completed[4]?.fact;
      if (
        service?.step !== "service-create" ||
        fact.imageId !== service.appImageId
      )
        throw new Error("Production application acknowledgement changed.");
    }
    if (fact.step === "route-verify") {
      const url = new URL(fact.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        fact.sourceSha256 !== binding.sourceSha256
      )
        throw new Error("Production route acknowledgement changed.");
    }
  }
  if (
    journal.pending &&
    (journal.pending.step !==
      PRODUCTION_PUBLISHING_STEPS[journal.completed.length] ||
      ids.has(journal.pending.id))
  )
    throw new Error("Production publishing pending effect changed.");
  return journal;
}
/** Creates only local intent; the caller persists it before performing the separately owned remote effect. */
export function beginProductionPublishingEffect(
  binding: unknown,
  journal_: unknown,
  claimToken: string,
  now: Date,
): ProductionPublishingJournal {
  z.uuid().parse(claimToken);
  const journal = validateProductionPublishingJournal(binding, journal_);
  const step = PRODUCTION_PUBLISHING_STEPS[journal.completed.length];
  if (journal.pending || !step)
    throw new Error(
      "Production publishing requires reconciliation or is already complete.",
    );
  return {
    ...journal,
    pending: {
      id: crypto.randomUUID(),
      step,
      claimToken,
      startedAt: now.toISOString(),
    },
  };
}
/** Acknowledges exactly one saved intent; lost/stale replies cannot clear or replace another effect. */
export function acknowledgeProductionPublishingEffect(
  binding: unknown,
  journal_: unknown,
  raw: unknown,
  claimToken: string,
): ProductionPublishingJournal {
  const journal = validateProductionPublishingJournal(binding, journal_),
    receipt = ProductionPublishingReceipt.parse(raw);
  if (
    !journal.pending ||
    journal.pending.claimToken !== claimToken ||
    JSON.stringify(receipt.effect) !== JSON.stringify(journal.pending)
  )
    throw new Error(
      "Production publishing acknowledgement no longer owns its intent.",
    );
  return validateProductionPublishingJournal(binding, {
    version: 1,
    pending: null,
    completed: [...journal.completed, receipt],
  });
}
