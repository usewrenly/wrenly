/** Removes only one quiescent operation's labelled preparation resources and retained image. */
import Docker from "dockerode";
import { cleanupRuntimeArtifactPreparation } from "./runtime-artifact";

const DOCKER_TIMEOUT_MS = 10_000;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: DOCKER_TIMEOUT_MS,
});
const OPERATION_LABEL = "io.wrenly.deployment-id";
const ROLE_LABEL = "io.wrenly.artifact-role";

/** The caller holds the resource kernel lock and records independent cleanup intent before calling. */
export async function cleanupOwnedRuntimeArtifact(
  operationId: string,
  assertHeld: () => Promise<void>,
): Promise<void> {
  try {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        operationId,
      )
    )
      throw new Error("Invalid artifact operation");
    await assertHeld();
    // This helper is already restricted to operation-labelled preparation resources.
    // The kernel lock prevents another executor from acquiring this operation meanwhile.
    await cleanupRuntimeArtifactPreparation(operationId, assertHeld);
    await assertHeld();
    const images = await docker.listImages({
      filters: JSON.stringify({
        label: [`${OPERATION_LABEL}=${operationId}`, `${ROLE_LABEL}=runtime`],
      }),
    });
    for (const image of images) {
      await assertHeld();
      const info = await docker.getImage(image.Id).inspect();
      if (
        info.Id !== image.Id ||
        info.Config.Labels?.[OPERATION_LABEL] !== operationId ||
        info.Config.Labels[ROLE_LABEL] !== "runtime"
      )
        throw new Error("Artifact ownership changed");
      await assertHeld();
      // An unexpected reference refuses cleanup instead of killing another workload.
      await docker.getImage(info.Id).remove({ force: false });
    }
    await assertHeld();
  } catch {
    throw new Error(
      "Runtime artifact cleanup could not be confirmed. Preserve the saved operation.",
    );
  }
}
