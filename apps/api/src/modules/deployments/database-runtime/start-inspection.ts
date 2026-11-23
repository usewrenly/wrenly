/** Lost start acknowledgements are proved by inspection, never by another start or credential send. */
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  createDatabaseRuntimeComposition,
  discoverDatabaseRuntimeService,
  type DatabaseRuntimePlacement,
  verifyDatabaseRuntimeService,
  type DeploymentProviderClient,
} from "@wrenly/deploy";
import {
  ProductionRuntimeHostRequest,
  ProductionRuntimeBrokerInspectionReply,
  ProductionRuntimeApplicationReply,
  ProductionRuntimeApplicationReadyReply,
} from "@wrenly/db/production-host-contract";
import { validateProductionPublishingJournal } from "@wrenly/db/production-publishing-contract";
import type { ProductionRuntimeCoordinator } from "./executor";
import type { ProductionServiceImages } from "./service-adapter";
import type { ProductionPublishingRuntimeSecrets } from "./secrets";
import { executeRuntimeHostRequest } from "../../databases/production-targets/deployment-hosts/transport";
type Input = Parameters<ProductionRuntimeCoordinator["perform"]>[0];
export interface ProductionStartInspectionConfiguration {
  brokerImageId: string;
  ingressImageId: string;
  images: ProductionServiceImages;
  upstream: ProductionPublishingRuntimeSecrets["database"]["upstream"];
  client: DeploymentProviderClient;
  placement: DatabaseRuntimePlacement;
}
/** Trusted installation settings and saved artifact receipts, rather than model/browser input, supply every expected identity. */
export async function inspectProductionStartEffect(
  input: Input & {
    credentials: Pick<ProductionPublishingRuntimeSecrets, "host">;
    runtime: ProductionStartInspectionConfiguration;
    assertHeld: () => Promise<void>;
    send?: typeof executeRuntimeHostRequest;
  },
): Promise<Awaited<ReturnType<ProductionRuntimeCoordinator["perform"]>>> {
  const { binding: b, effect, signal, runtime } = input;
  const journal = validateProductionPublishingJournal(b, input.journal);
  if (JSON.stringify(journal.pending) !== JSON.stringify(effect))
    throw new Error("Original start intent changed.");
  const base = {
    version: 1,
    nonce: effect.id,
    expectedDockerId: b.dockerId,
    deploymentId: b.deploymentId,
    projectId: b.projectId,
    resourceId: b.resourceId,
    claimToken: effect.claimToken,
    confirmDurableIntent: true,
  };
  const send = async (request: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    await input.assertHeld();
    const reply = await (input.send ?? executeRuntimeHostRequest)({
      ...input.credentials.host,
      request: ProductionRuntimeHostRequest.parse(request),
      signal,
    });
    signal.throwIfAborted();
    await input.assertHeld();
    return reply;
  };
  if (effect.step === "broker-start") {
    const network = journal.completed[2]?.fact;
    if (network?.step !== "broker-network")
      throw new Error("Original network receipt is missing.");
    const reply = ProductionRuntimeBrokerInspectionReply.parse(
      await send({
        ...base,
        action: "find-runtime-broker",
        imageId: runtime.brokerImageId,
        networkId: network.networkId,
        upstream: runtime.upstream,
      }),
    );
    if (
      reply.nonce !== effect.id ||
      reply.dockerId !== b.dockerId ||
      reply.imageId !== runtime.brokerImageId ||
      reply.networkId !== network.networkId ||
      reply.volumeName !== `wrenly-deployment-db-${b.deploymentId}` ||
      !reply.running ||
      !reply.socketReady
    )
      throw new Error("Original broker readiness is not verified.");
    return {
      step: "broker-start",
      containerId: reply.containerId,
      imageId: reply.imageId,
      networkId: reply.networkId,
      volumeName: reply.volumeName,
    };
  }
  if (effect.step === "service-create") {
    if (runtime.placement.serverUuid !== b.serverId)
      throw new Error("Saved server placement changed.");
    const composition = {
      deploymentId: b.deploymentId,
      projectId: b.projectId,
      resourceId: b.resourceId,
      appImage: runtime.images.appImage,
      ingressImage: runtime.images.ingressImage,
      framework: runtime.images.framework,
    };
    const document = createDatabaseRuntimeComposition(composition).document;
    await input.assertHeld();
    const serviceId = await discoverDatabaseRuntimeService(
      runtime.client,
      composition,
      runtime.placement,
      signal,
    );
    await input.assertHeld();
    signal.throwIfAborted();
    if (!serviceId)
      throw new Error(
        "Original service is absent; creation cannot be acknowledged.",
      );
    return {
      step: "service-create",
      serviceId,
      compositionSha256: createHash("sha256").update(document).digest("hex"),
      appImageId: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(runtime.images.appImageId),
      appRegistryDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(runtime.images.appImage.split("@")[1]),
      ingressRegistryDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .parse(runtime.images.ingressImage.split("@")[1]),
    };
  }
  if (effect.step !== "service-start" && effect.step !== "application-start")
    throw new Error("Unsupported start inspection.");
  const service = journal.completed[4]?.fact;
  if (
    service?.step !== "service-create" ||
    service.appImageId !== runtime.images.appImageId ||
    service.appRegistryDigest !== runtime.images.appImage.split("@")[1] ||
    service.ingressRegistryDigest !== runtime.images.ingressImage.split("@")[1]
  )
    throw new Error("Original service images changed.");
  const composition = {
    deploymentId: b.deploymentId,
    projectId: b.projectId,
    resourceId: b.resourceId,
    appImage: runtime.images.appImage,
    ingressImage: runtime.images.ingressImage,
    framework: runtime.images.framework,
  };
  if (
    createHash("sha256")
      .update(createDatabaseRuntimeComposition(composition).document)
      .digest("hex") !== service.compositionSha256
  )
    throw new Error("Saved service composition changed.");
  // This read independently validates the provider composition before host discovery.
  await input.assertHeld();
  await verifyDatabaseRuntimeService(
    runtime.client,
    service.serviceId,
    composition,
    signal,
  );
  const app = ProductionRuntimeApplicationReply.parse(
    await send({
      ...base,
      action: "find-runtime-application",
      imageId: runtime.images.appImageId,
    }),
  );
  const valid = (
    reply: z.infer<typeof ProductionRuntimeApplicationReply>,
    imageId: string,
  ): void => {
    if (
      reply.nonce !== effect.id ||
      reply.dockerId !== b.dockerId ||
      reply.imageId !== imageId ||
      !reply.running
    )
      throw new Error("Original runtime is not running with verified policy.");
  };
  valid(app, runtime.images.appImageId);
  if (effect.step === "service-start") {
    const ingress = ProductionRuntimeApplicationReply.parse(
      await send({
        ...base,
        action: "find-runtime-ingress",
        imageId: runtime.ingressImageId,
      }),
    );
    valid(ingress, runtime.ingressImageId);
    return { step: "service-start", serviceId: service.serviceId };
  }
  const ready = ProductionRuntimeApplicationReadyReply.parse(
    await send({
      ...base,
      action: "verify-runtime-application-ready",
      containerId: app.containerId,
      imageId: app.imageId,
    }),
  );
  valid(ready, app.imageId);
  if (ready.containerId !== app.containerId)
    throw new Error("Application handoff identity changed.");
  return {
    step: "application-start",
    containerId: app.containerId,
    imageId: app.imageId,
  };
}
