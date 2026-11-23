/** Read-only proofs for uncertain runtime setup. No create/start/credential-delivery request is accepted here. */
import {
  inspectProductionStartEffect,
  type ProductionStartInspectionConfiguration,
} from "./start-inspection";
import {
  ProductionRuntimeHostRequest,
  ProductionRuntimeVolumeReply,
  ProductionRuntimeNetworkReply,
} from "@wrenly/db/production-host-contract";
import {
  validateProductionPublishingJournal,
  type ProductionPublishingReceipt,
} from "@wrenly/db/production-publishing-contract";
import type { z } from "zod";
import type { ProductionRuntimeCoordinator } from "./executor";
import type { ProductionPublishingRuntimeSecrets } from "./secrets";
import { executeRuntimeHostRequest } from "../../databases/production-targets/deployment-hosts/transport";
type Input = Parameters<ProductionRuntimeCoordinator["perform"]>[0];
type Fact = z.infer<typeof ProductionPublishingReceipt>["fact"];
/** A missing resource is reported separately: it cannot acknowledge an original creation. */
export async function inspectProductionSetupEffect(
  input: Input & {
    credentials: Pick<ProductionPublishingRuntimeSecrets, "host">;
    assertHeld: () => Promise<void>;
    runtime?: ProductionStartInspectionConfiguration;
    send?: typeof executeRuntimeHostRequest;
  },
): Promise<Fact | null> {
  const { binding, effect, signal } = input;
  const journal = validateProductionPublishingJournal(binding, input.journal);
  if (JSON.stringify(journal.pending) !== JSON.stringify(effect))
    throw new Error("The original setup intent changed.");
  if (
    [
      "broker-start",
      "service-create",
      "service-start",
      "application-start",
    ].includes(effect.step)
  ) {
    if (!input.runtime)
      throw new Error("Restore the trusted start inspection configuration.");
    return inspectProductionStartEffect({ ...input, runtime: input.runtime });
  }
  if (
    effect.step !== "http-volume" &&
    effect.step !== "database-volume" &&
    effect.step !== "broker-network"
  )
    throw new Error(
      "This inspector cannot verify a credential, service or SQL action.",
    );
  await input.assertHeld();
  signal.throwIfAborted();
  const base = {
    version: 1,
    nonce: effect.id,
    expectedDockerId: binding.dockerId,
    deploymentId: binding.deploymentId,
    projectId: binding.projectId,
    resourceId: binding.resourceId,
    claimToken: effect.claimToken,
    confirmDurableIntent: true,
  };
  const output = await (input.send ?? executeRuntimeHostRequest)({
    ...input.credentials.host,
    signal,
    request: ProductionRuntimeHostRequest.parse({
      ...base,
      action:
        effect.step === "broker-network"
          ? "inspect-runtime-network"
          : "inspect-runtime-volumes",
    }),
  });
  await input.assertHeld();
  signal.throwIfAborted();
  if (effect.step === "broker-network") {
    const reply = ProductionRuntimeNetworkReply.parse(output);
    if (reply.nonce !== effect.id || reply.dockerId !== binding.dockerId)
      throw new Error("Setup network proof changed.");
    if (!reply.network) return null;
    if (
      reply.network.name !== `wrenly-deployment-network-${binding.deploymentId}`
    )
      throw new Error("A different deployment network was returned.");
    return { step: "broker-network", networkId: reply.network.id };
  }
  const reply = ProductionRuntimeVolumeReply.parse(output);
  if (reply.nonce !== effect.id || reply.dockerId !== binding.dockerId)
    throw new Error("Setup volume proof changed.");
  const volume = effect.step === "http-volume" ? reply.http : reply.database;
  if (!volume) return null;
  const name =
    effect.step === "http-volume"
      ? `wrenly-deployment-http-${binding.deploymentId}`
      : `wrenly-deployment-db-${binding.deploymentId}`;
  if (volume.name !== name)
    throw new Error("A different deployment volume was returned.");
  return { step: effect.step, name: volume.name, createdAt: volume.createdAt };
}
