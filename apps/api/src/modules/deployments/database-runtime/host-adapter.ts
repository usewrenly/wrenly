import { validateProductionPublishingJournal } from "@wrenly/db/production-publishing-contract";
/** Converts persisted runtime effects into one fixed authenticated host request; no browser command or endpoint participates. */
import { z } from "zod";
import {
  ProductionRuntimeHostRequest,
  ProductionRuntimeVolumeReply,
  ProductionRuntimeNetworkReply,
  ProductionRuntimeBrokerReply,
  ProductionRuntimeApplicationReply,
} from "@wrenly/db/production-host-contract";
import { executeRuntimeHostRequest } from "../../databases/production-targets/deployment-hosts/transport";
import type { ProductionRuntimeCoordinator } from "./executor";
import type { ProductionPublishingRuntimeSecrets } from "./secrets";
type EffectInput = Parameters<ProductionRuntimeCoordinator["perform"]>[0];
type Fact = Awaited<ReturnType<ProductionRuntimeCoordinator["perform"]>>;
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** The caller freezes the trusted broker image in its execution configuration and loads credentials only after claim checks. */
export async function executeProductionHostEffect(
  input: EffectInput & {
    brokerImageId: string;
    credentials: ProductionPublishingRuntimeSecrets;
    send?: typeof executeRuntimeHostRequest;
  },
): Promise<Fact> {
  const { binding, journal, effect, signal, credentials } = input;
  const checked = validateProductionPublishingJournal(binding, journal);
  if (JSON.stringify(checked.pending) !== JSON.stringify(effect))
    throw new Error("Production host effect does not match saved intent.");
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
  let request: unknown;
  switch (effect.step) {
    case "http-volume":
      request = { ...base, action: "create-http-volume" };
      break;
    case "database-volume":
      request = { ...base, action: "create-database-volume" };
      break;
    case "broker-network":
      request = { ...base, action: "create-runtime-network" };
      break;
    case "broker-start": {
      const network = journal.completed[2]?.fact;
      if (network?.step !== "broker-network")
        throw new Error("Missing saved broker network.");
      request = {
        ...base,
        action: "create-runtime-broker",
        imageId: ImageId.parse(input.brokerImageId),
        networkId: network.networkId,
        ...credentials.database,
      };
      break;
    }
    default:
      throw new Error(
        "This publishing effect does not use the host provisioning adapter.",
      );
  }
  try {
    const parsed = ProductionRuntimeHostRequest.parse(request);
    const output = await (input.send ?? executeRuntimeHostRequest)({
      ...credentials.host,
      request: parsed,
      signal,
    });
    if (effect.step === "http-volume" || effect.step === "database-volume") {
      const reply = ProductionRuntimeVolumeReply.parse(output),
        volume = effect.step === "http-volume" ? reply.http : reply.database;
      const expected =
        effect.step === "http-volume"
          ? `wrenly-deployment-http-${binding.deploymentId}`
          : `wrenly-deployment-db-${binding.deploymentId}`;
      if (
        reply.nonce !== effect.id ||
        reply.dockerId !== binding.dockerId ||
        volume?.name !== expected
      )
        throw new Error("Volume acknowledgement changed.");
      return {
        step: effect.step,
        name: volume.name,
        createdAt: volume.createdAt,
      };
    }
    if (effect.step === "broker-network") {
      const reply = ProductionRuntimeNetworkReply.parse(output);
      if (
        reply.nonce !== effect.id ||
        reply.dockerId !== binding.dockerId ||
        reply.network?.name !==
          `wrenly-deployment-network-${binding.deploymentId}`
      )
        throw new Error("Network acknowledgement changed.");
      return { step: effect.step, networkId: reply.network.id };
    }
    const reply = ProductionRuntimeBrokerReply.parse(output),
      network = journal.completed[2]?.fact;
    if (
      reply.nonce !== effect.id ||
      reply.dockerId !== binding.dockerId ||
      reply.imageId !== input.brokerImageId ||
      network?.step !== "broker-network" ||
      reply.networkId !== network.networkId ||
      reply.volumeName !== `wrenly-deployment-db-${binding.deploymentId}`
    )
      throw new Error("Broker acknowledgement changed.");
    return {
      step: "broker-start",
      containerId: reply.containerId,
      imageId: reply.imageId,
      networkId: reply.networkId,
      volumeName: reply.volumeName,
    };
  } catch {
    throw new Error(
      "Production host effect could not be confirmed. Inspect its saved intent before retrying.",
    );
  }
}
/** Provider discovery supplies only an ID; the fixed helper independently proves the app's guardian image, mounts and isolation. */
export async function executeProductionApplicationEffect(
  input: EffectInput & {
    framework: "nextjs" | "laravel";
    containerId: string;
    credentials: ProductionPublishingRuntimeSecrets;
    send?: typeof executeRuntimeHostRequest;
  },
): Promise<Fact> {
  const { binding, journal, effect, signal, credentials } = input;
  const checked = validateProductionPublishingJournal(binding, journal);
  if (JSON.stringify(checked.pending) !== JSON.stringify(effect))
    throw new Error("Production host effect does not match saved intent.");
  if (effect.step !== "application-start")
    throw new Error("Unexpected application effect.");
  const broker = journal.completed[3]?.fact,
    service = journal.completed[4]?.fact;
  if (broker?.step !== "broker-start" || service?.step !== "service-create")
    throw new Error("Missing saved Production runtime identities.");
  const request = ProductionRuntimeHostRequest.parse({
    version: 1,
    action: "start-runtime-application",
    nonce: effect.id,
    expectedDockerId: binding.dockerId,
    deploymentId: binding.deploymentId,
    projectId: binding.projectId,
    resourceId: binding.resourceId,
    claimToken: effect.claimToken,
    confirmDurableIntent: true,
    containerId: input.containerId,
    imageId: service.appImageId,
    framework: input.framework,
    runtimeRole: credentials.database.runtimeRole,
    appKey: input.framework === "laravel" ? credentials.appKey : null,
    brokerId: broker.containerId,
    brokerImageId: broker.imageId,
    networkId: broker.networkId,
    upstream: credentials.database.upstream,
    addresses: credentials.database.addresses,
  });
  try {
    const reply = ProductionRuntimeApplicationReply.parse(
      await (input.send ?? executeRuntimeHostRequest)({
        ...credentials.host,
        request,
        signal,
      }),
    );
    if (
      reply.nonce !== effect.id ||
      reply.dockerId !== binding.dockerId ||
      reply.containerId !== input.containerId ||
      reply.imageId !== service.appImageId ||
      !reply.running
    )
      throw new Error("Application acknowledgement changed.");
    return {
      step: "application-start",
      containerId: reply.containerId,
      imageId: reply.imageId,
    };
  } catch {
    throw new Error(
      "Production application start could not be confirmed. Inspect its saved intent before retrying.",
    );
  }
}

/** Read-only discovery is repeated only by the caller's bounded readiness polling; it never starts a container or sends a database password. */
export async function discoverProductionApplication(
  input: EffectInput & {
    credentials: ProductionPublishingRuntimeSecrets;
    send?: typeof executeRuntimeHostRequest;
  },
): Promise<string> {
  const { binding, journal, effect, credentials, signal } = input;
  const checked = validateProductionPublishingJournal(binding, journal),
    service = journal.completed[4]?.fact;
  if (
    effect.step !== "application-start" ||
    JSON.stringify(checked.pending) !== JSON.stringify(effect) ||
    service?.step !== "service-create"
  )
    throw new Error("Missing saved application discovery intent.");
  try {
    const request = ProductionRuntimeHostRequest.parse({
      version: 1,
      action: "find-runtime-application",
      nonce: effect.id,
      expectedDockerId: binding.dockerId,
      deploymentId: binding.deploymentId,
      projectId: binding.projectId,
      resourceId: binding.resourceId,
      claimToken: effect.claimToken,
      confirmDurableIntent: true,
      imageId: service.appImageId,
    });
    const reply = ProductionRuntimeApplicationReply.parse(
      await (input.send ?? executeRuntimeHostRequest)({
        ...credentials.host,
        request,
        signal,
      }),
    );
    if (
      reply.nonce !== effect.id ||
      reply.dockerId !== binding.dockerId ||
      reply.imageId !== service.appImageId
    )
      throw new Error("Application discovery changed.");
    return reply.containerId;
  } catch {
    throw new Error(
      "The exact Production application could not be discovered. No runtime credentials were sent.",
    );
  }
}
