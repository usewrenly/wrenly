/** Coolify mutations consume saved runtime effects and never receive database or SSH credentials. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createDatabaseRuntimeComposition,
  createDatabaseRuntimeService,
  verifyDatabaseRuntimeService,
  startDatabaseRuntimeService,
  type DatabaseRuntimeCompositionInput,
  type DeploymentProviderClient,
} from "@wrenly/deploy";
import { validateProductionPublishingJournal } from "@wrenly/db/production-publishing-contract";
import type { ProductionRuntimeCoordinator } from "./executor";
type Input = Parameters<ProductionRuntimeCoordinator["perform"]>[0];
const ImageId = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export interface ProductionServiceImages {
  appImageId: string;
  appImage: string;
  ingressImage: string;
  framework: "nextjs" | "laravel";
}
/** Caller obtains image references from verified artifact promotion and trusted toolchain configuration, never browser input. */
export async function executeProductionServiceEffect(
  input: Input & {
    client: DeploymentProviderClient;
    images: ProductionServiceImages;
    placement: {
      projectUuid: string;
      serverUuid: string;
      environmentName: string;
    };
  },
): Promise<Awaited<ReturnType<ProductionRuntimeCoordinator["perform"]>>> {
  const { binding, effect, journal, signal, images } = input;
  const saved = validateProductionPublishingJournal(binding, journal);
  if (
    JSON.stringify(saved.pending) !== JSON.stringify(effect) ||
    input.placement.serverUuid !== binding.serverId
  )
    throw new Error("Production service placement or saved intent changed.");
  ImageId.parse(images.appImageId);
  const compositionInput: DatabaseRuntimeCompositionInput = {
    deploymentId: binding.deploymentId,
    projectId: binding.projectId,
    resourceId: binding.resourceId,
    appImage: images.appImage,
    ingressImage: images.ingressImage,
    framework: images.framework,
  };
  const composition = createDatabaseRuntimeComposition(compositionInput),
    compositionSha256 = createHash("sha256")
      .update(composition.document)
      .digest("hex");
  try {
    if (effect.step === "service-create") {
      const serviceId = await createDatabaseRuntimeService(
        input.client,
        { ...compositionInput, ...input.placement },
        signal,
      );
      await verifyDatabaseRuntimeService(
        input.client,
        serviceId,
        compositionInput,
        signal,
      );
      return {
        step: "service-create",
        serviceId,
        compositionSha256,
        appImageId: images.appImageId,
        appRegistryDigest: ImageId.parse(images.appImage.split("@")[1]),
        ingressRegistryDigest: ImageId.parse(images.ingressImage.split("@")[1]),
      };
    }
    if (effect.step !== "service-start")
      throw new Error("Unexpected service effect.");
    const created = journal.completed[4]?.fact;
    if (
      created?.step !== "service-create" ||
      created.compositionSha256 !== compositionSha256 ||
      created.appImageId !== images.appImageId ||
      created.appRegistryDigest !== images.appImage.split("@")[1] ||
      created.ingressRegistryDigest !== images.ingressImage.split("@")[1]
    )
      throw new Error("Saved Production composition changed.");
    await verifyDatabaseRuntimeService(
      input.client,
      created.serviceId,
      compositionInput,
      signal,
    );
    await startDatabaseRuntimeService(input.client, created.serviceId, signal);
    return { step: "service-start", serviceId: created.serviceId };
  } catch {
    throw new Error(
      "Production service effect could not be confirmed. Inspect its saved intent before retrying.",
    );
  }
}
