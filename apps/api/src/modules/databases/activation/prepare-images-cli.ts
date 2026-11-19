/** One-time explicit promotion of the trusted relay, without opening the control database. */
import { z } from "zod";
import { publishTrustedDeploymentIngress } from "@wrenly/sandbox/private-image-registry";
import { readProductionInstallationImages } from "@wrenly/sandbox/production-deployment-toolchain";
const Registry = z.object({
  WRENLY_REGISTRY_URL: z.url(),
  WRENLY_REGISTRY_NAMESPACE: z
    .string()
    .regex(/^[a-z0-9_-]{1,100}$/)
    .default("wrenly"),
  WRENLY_REGISTRY_USERNAME: z.string().min(1),
  WRENLY_REGISTRY_PASSWORD: z.string().min(1),
});
async function main(): Promise<void> {
  if (process.argv.slice(2).join(" ") !== "--confirm-private-upload") {
    process.stderr.write(
      "Usage: bun run prepare-production-images --confirm-private-upload\nBuild the trusted database-socket and deployment-ingress images first. This explicitly uploads the relay to the configured private registry.\n",
    );
    process.exitCode = 1;
    return;
  }
  const parsed = Registry.safeParse(process.env);
  if (!parsed.success) {
    process.stderr.write(
      `Set valid registry configuration: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}\n`,
    );
    process.exitCode = 1;
    return;
  }
  try {
    const images = await readProductionInstallationImages();
    const config = parsed.data;
    const uploaded = await publishTrustedDeploymentIngress({
      imageId: images.ingressImageId,
      origin: config.WRENLY_REGISTRY_URL,
      namespace: config.WRENLY_REGISTRY_NAMESPACE,
      username: config.WRENLY_REGISTRY_USERNAME,
      password: config.WRENLY_REGISTRY_PASSWORD,
      signal: AbortSignal.timeout(300000),
      beforeEffect: async () => {},
    });
    process.stdout.write(
      `WRENLY_PRODUCTION_BROKER_IMAGE_ID=${images.brokerImageId}\nWRENLY_PRODUCTION_INGRESS_IMAGE_ID=${images.ingressImageId}\nWRENLY_PRODUCTION_INGRESS_IMAGE=${uploaded.repository}@${uploaded.digest}\n`,
    );
  } catch {
    process.stderr.write(
      "Production image preparation could not be verified. Check the trusted image builds and private registry access; Production has not been enabled.\n",
    );
    process.exitCode = 1;
  }
}
await main();
