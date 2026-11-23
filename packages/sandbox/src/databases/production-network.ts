/** Project-labelled broker network creation; never adopts an existing network after an unknown result. */
import Docker from "dockerode";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
import type { DatabaseRuntimeFence } from "./database-runtime";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
/** The caller persists the exact returned Docker ID before the separately durable effect acknowledgement. */
export async function createProductionDatabaseNetwork(input: {
  scope: { resourceId: string; projectId: string; environment: "production" };
  fence: DatabaseRuntimeFence;
  signal: AbortSignal;
  saveIdentity: (networkId: string) => Promise<void>;
}): Promise<string> {
  if (!UUID.test(input.scope.resourceId) || !UUID.test(input.scope.projectId))
    throw new Error("Invalid Production resource identity.");
  if (input.scope.environment !== "production")
    throw new Error("Invalid Production broker scope.");
  const name = `wrenly-production-network-${input.scope.resourceId}`;
  const effect = { kind: "create-network" as const, id: name };
  const labels = {
    "io.wrenly.database-id": input.scope.resourceId,
    "io.wrenly.project-id": input.scope.projectId,
    "io.wrenly.database-environment": "production",
    "io.wrenly.role": "database-network",
  };
  try {
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const existing = await docker.listNetworks({
      filters: JSON.stringify({ name: [name] }),
    });
    if (existing.some((network) => network.Name === name))
      throw new Error("Existing broker network requires inspection.");
    await input.fence.beforeEffect(effect);
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    const network = await docker.createNetwork({
      Name: name,
      Driver: "bridge",
      Internal: false,
      EnableIPv6: false,
      Labels: labels,
    });
    const saved = await network.inspect();
    if (
      !/^[a-f0-9]{64}$/.test(saved.Id) ||
      saved.Driver !== "bridge" ||
      saved.Internal ||
      saved.EnableIPv6 ||
      Object.entries(labels).some(
        ([key, value]) => saved.Labels?.[key] !== value,
      )
    )
      throw new Error("Broker network identity changed.");
    await input.fence.assertHeld();
    input.signal.throwIfAborted();
    await input.saveIdentity(saved.Id);
    await input.fence.acknowledgeEffect(effect);
    return saved.Id;
  } catch {
    throw new Error(
      "Production broker network creation could not be confirmed. Inspect the saved operation before continuing.",
    );
  }
}
