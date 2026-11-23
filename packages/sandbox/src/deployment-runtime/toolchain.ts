/** Reject changed trusted images before Production workers can claim durable work. */
import Docker from "dockerode";
const BROKER_TAG = "wrenly/database-socket:2";
const INGRESS_TAG = "wrenly/deployment-ingress:1";
interface ImageFacts {
  Id: string;
  Config: {
    User?: string;
    Entrypoint?: string | string[];
    Labels?: Record<string, string>;
  };
}
/** Installation pins IDs, while fixed repository toolchain properties guard accidental tag substitution. */
export function validateProductionImageFacts(
  images: { brokerImageId: string; ingressImageId: string },
  broker: ImageFacts,
  ingress: ImageFacts,
): void {
  if (
    broker.Id !== images.brokerImageId ||
    ingress.Id !== images.ingressImageId ||
    broker.Config.User !== "1000:1000" ||
    ingress.Config.User !== "1000:1000" ||
    JSON.stringify(broker.Config.Entrypoint) !==
      JSON.stringify(["bun", "--no-env-file", "/wrenly/entrypoint.ts"]) ||
    JSON.stringify(ingress.Config.Entrypoint) !==
      JSON.stringify(["bun", "--no-env-file", "/wrenly/ingress.js"]) ||
    ingress.Config.Labels?.["io.wrenly.runtime-role"] !==
      "deployment-ingress" ||
    ingress.Config.Labels?.["io.wrenly.runtime-version"] !== "1"
  )
    throw new Error(
      "Trusted Production image identity changed. Rebuild and verify the repository toolchains.",
    );
}
/** Reads only the explicit local Docker daemon; never pulls, tags or starts an image. */
export async function verifyProductionInstallationImages(images: {
  brokerImageId: string;
  ingressImageId: string;
}): Promise<void> {
  try {
    const docker = new Docker({
      socketPath: "/var/run/docker.sock",
      timeout: 10000,
    });
    const [broker, ingress] = await Promise.all([
      docker.getImage(BROKER_TAG).inspect(),
      docker.getImage(INGRESS_TAG).inspect(),
    ]);
    validateProductionImageFacts(images, broker, ingress);
  } catch {
    throw new Error(
      "Production trusted images could not be verified. Build the database-socket and deployment-ingress toolchains and configure their exact IDs.",
    );
  }
}

/** Returns verified local toolchain pins for the explicitly requested installation upload. */
export async function readProductionInstallationImages(): Promise<{
  brokerImageId: string;
  ingressImageId: string;
}> {
  try {
    const docker = new Docker({
      socketPath: "/var/run/docker.sock",
      timeout: 10000,
    });
    const [broker, ingress] = await Promise.all([
      docker.getImage(BROKER_TAG).inspect(),
      docker.getImage(INGRESS_TAG).inspect(),
    ]);
    const images = { brokerImageId: broker.Id, ingressImageId: ingress.Id };
    validateProductionImageFacts(images, broker, ingress);
    return images;
  } catch {
    throw new Error(
      "Production toolchains are missing or do not match the repository-built runtime.",
    );
  }
}
