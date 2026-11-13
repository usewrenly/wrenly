/** A provider's running status does not prove public routing or the expected published revision. */
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  createDatabaseRuntimeComposition,
  readDatabaseRuntimeServiceRoute,
  type DeploymentProviderClient,
} from "@wrenly/deploy";
import {
  ProductionRuntimeHostRequest,
  ProductionRuntimeApplicationReply,
  ProductionRuntimeBrokerInspectionReply,
} from "@wrenly/db/production-host-contract";
import {
  validateProductionPublishingJournal,
  PRODUCTION_PUBLISHING_STEPS,
} from "@wrenly/db/production-publishing-contract";
import { executeRuntimeHostRequest } from "../../databases/production-targets/deployment-hosts/transport";
import { verifyDeploymentReadiness } from "../../../../../../packages/deploy/src/providers/coolify/readiness";
import type { ProductionRuntimeCoordinator } from "./executor";
import type { ProductionPublishingRuntimeSecrets } from "./secrets";
import type { ProductionServiceImages } from "./service-adapter";
type Input = Parameters<ProductionRuntimeCoordinator["perform"]>[0];
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** This performs one read-only proof attempt. The worker may poll readiness, but never repeats a prior runtime mutation. */
async function verifyRuntimeRoute(
  input: Input & {
    client: DeploymentProviderClient;
    images: ProductionServiceImages;
    ingressImageId: string;
    credentials: ProductionPublishingRuntimeSecrets;
    assertHeld: () => Promise<void>;
    send?: typeof executeRuntimeHostRequest;
    ready?: typeof verifyDeploymentReadiness;
    maintenance?: import("@wrenly/db/production-maintenance-contract").ProductionMaintenanceGrant;
  },
): Promise<Awaited<
  ReturnType<ProductionRuntimeCoordinator["perform"]>
> | null> {
  const { binding, journal, effect, signal, credentials, images } = input;
  const saved = validateProductionPublishingJournal(binding, journal),
    service = saved.completed[4]?.fact,
    broker = saved.completed[3]?.fact,
    app = saved.completed[6]?.fact;
  if (
    effect.step !== "route-verify" ||
    (input.maintenance
      ? input.maintenance.state !== "enabled" ||
        JSON.stringify(input.maintenance.binding) !== JSON.stringify(binding) ||
        JSON.stringify(input.maintenance.publication) !==
          JSON.stringify(saved) ||
        saved.pending !== null ||
        saved.completed.length !== PRODUCTION_PUBLISHING_STEPS.length
      : JSON.stringify(saved.pending) !== JSON.stringify(effect)) ||
    service?.step !== "service-create" ||
    broker?.step !== "broker-start" ||
    app?.step !== "application-start" ||
    service.appImageId !== images.appImageId ||
    service.appRegistryDigest !== images.appImage.split("@")[1] ||
    service.ingressRegistryDigest !== images.ingressImage.split("@")[1]
  )
    throw new Error("Production route intent or images changed.");
  const ingressImageId = ImageId.parse(input.ingressImageId);
  const composition = {
    deploymentId: binding.deploymentId,
    projectId: binding.projectId,
    resourceId: binding.resourceId,
    appImage: images.appImage,
    ingressImage: images.ingressImage,
    framework: images.framework,
  };
  // Reconstructing also validates both digest references before any remote request.
  if (
    createHash("sha256")
      .update(createDatabaseRuntimeComposition(composition).document)
      .digest("hex") !== service.compositionSha256
  )
    throw new Error("Saved Production route composition changed.");
  const base = {
    version: 1 as const,
    nonce: effect.id,
    expectedDockerId: binding.dockerId,
    deploymentId: binding.deploymentId,
    projectId: binding.projectId,
    resourceId: binding.resourceId,
    claimToken: effect.claimToken,
    confirmDurableIntent: true as const,
  };
  const send = async (request: unknown): Promise<unknown> => {
    signal.throwIfAborted();
    await input.assertHeld();
    return (input.send ?? executeRuntimeHostRequest)({
      ...credentials.host,
      request: ProductionRuntimeHostRequest.parse(request),
      signal,
    });
  };
  try {
    await input.assertHeld();
    const url = await readDatabaseRuntimeServiceRoute(
      input.client,
      service.serviceId,
      composition,
      signal,
    );
    if (!url) return null;
    const brokerProof = ProductionRuntimeBrokerInspectionReply.parse(
      await send({
        ...base,
        action: "inspect-runtime-broker",
        containerId: broker.containerId,
        imageId: broker.imageId,
        networkId: broker.networkId,
        upstream: credentials.database.upstream,
      }),
    );
    if (
      brokerProof.nonce !== effect.id ||
      brokerProof.dockerId !== binding.dockerId ||
      brokerProof.containerId !== broker.containerId ||
      brokerProof.imageId !== broker.imageId ||
      brokerProof.networkId !== broker.networkId ||
      brokerProof.volumeName !== broker.volumeName
    )
      throw new Error("Broker route proof changed.");
    const appProof = ProductionRuntimeApplicationReply.parse(
      await send({
        ...base,
        action: "inspect-runtime-application",
        containerId: app.containerId,
        imageId: app.imageId,
      }),
    );
    const ingressProof = ProductionRuntimeApplicationReply.parse(
      await send({
        ...base,
        action: "find-runtime-ingress",
        imageId: ingressImageId,
      }),
    );
    if (
      appProof.nonce !== effect.id ||
      appProof.dockerId !== binding.dockerId ||
      appProof.containerId !== app.containerId ||
      appProof.imageId !== app.imageId ||
      ingressProof.nonce !== effect.id ||
      ingressProof.dockerId !== binding.dockerId ||
      ingressProof.imageId !== ingressImageId
    )
      throw new Error("Application or ingress route proof changed.");
    if (
      !brokerProof.running ||
      !brokerProof.socketReady ||
      !appProof.running ||
      !ingressProof.running
    )
      return null;
    if (
      !(await (input.ready ?? verifyDeploymentReadiness)(
        url,
        binding.deploymentId,
        signal,
      ))
    )
      return null;
    await input.assertHeld();
    signal.throwIfAborted();
    return { step: "route-verify", url, sourceSha256: binding.sourceSha256 };
  } catch {
    throw new Error(
      "Production route could not be confirmed. Its saved publishing intent is preserved.",
    );
  }
}

/** Publishing requires its exact pending route intent. */
export async function verifyProductionRouteEffect(
  input: Omit<Parameters<typeof verifyRuntimeRoute>[0], "maintenance">,
): ReturnType<typeof verifyRuntimeRoute> {
  return verifyRuntimeRoute({ ...input, maintenance: undefined });
}
/** Maintenance checks the unchanged completed publication using its own separately persisted effect identity. */
export async function verifyMaintainedProductionRoute(
  input: Omit<
    Parameters<typeof verifyRuntimeRoute>[0],
    "binding" | "journal" | "effect" | "maintenance"
  > & {
    grant: import("@wrenly/db/production-maintenance-contract").ProductionMaintenanceGrant;
    effect: NonNullable<
      import("@wrenly/db/production-maintenance-attempt").MaintenanceAttempt["pending"]
    >;
    claimToken: string;
  },
): ReturnType<typeof verifyRuntimeRoute> {
  if (input.effect.step !== "route-verify")
    throw new Error("Maintenance route effect changed.");
  return verifyRuntimeRoute({
    ...input,
    binding: input.grant.binding,
    journal: input.grant.publication,
    maintenance: input.grant,
    effect: {
      id: input.effect.id,
      step: "route-verify",
      claimToken: input.claimToken,
      startedAt: new Date().toISOString(),
    },
  });
}
