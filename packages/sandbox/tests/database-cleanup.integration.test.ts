// Creates only fresh UUID-scoped, never-started containers and empty storage.
// Refusal must leave every fixture resource intact; no operator resource is selected.
import { describe, expect, test } from "bun:test";
import Docker from "dockerode";
import { cleanupDisposableDatabase, POSTGRES_RUNTIME_IMAGE } from "../src/databases/database-runtime";
import { managedDatabaseLabels, managedDatabaseNames, type ManagedDatabaseScope } from "../src/databases/database-resource-policy";

const integration = process.env.WRENLY_TEST_APP_DATABASE_RUNTIME === "true" ? describe : describe.skip;
const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });

integration("disposable database cleanup ownership", () => {
  test.each(["container-environment", "container-purpose", "volume-environment", "network-environment", "owned"] as const)("%s", async (scenario) => {
    const scope: ManagedDatabaseScope = {
      projectId: crypto.randomUUID(), resourceId: crypto.randomUUID(), environment: "development",
    };
    const sourceResourceId = crypto.randomUUID();
    const names = managedDatabaseNames(scope);
    let container: Docker.Container | undefined;
    let network: Docker.Network | undefined;
    let volume: Docker.Volume | undefined;
    const labels = (kind: "database" | "database-data" | "database-network"): Record<string, string> => {
      const result = managedDatabaseLabels(scope, kind);
      if (scenario === "container-purpose" && kind === "database") result["io.wrenly.role"] = "database-initializer";
      if ((scenario === "container-environment" && kind === "database") ||
          (scenario === "volume-environment" && kind === "database-data") ||
          (scenario === "network-environment" && kind === "database-network")) {
        result["io.wrenly.database-environment"] = "production";
      }
      return result;
    };
    try {
      // Resolve the trusted local image; these tests never download or run an image.
      const image = await docker.getImage(POSTGRES_RUNTIME_IMAGE).inspect();
      await docker.createVolume({ Name: names.volume, Labels: labels("database-data") });
      volume = docker.getVolume(names.volume);
      network = await docker.createNetwork({ Name: names.network, Internal: true, Labels: labels("database-network") });
      container = await docker.createContainer({ name: names.container, Image: image.Id, User: "70:70",
        Labels: labels("database"), HostConfig: { NetworkMode: "none" } });
      if (scenario === "owned") {
        await cleanupDisposableDatabase(scope, scope.resourceId, sourceResourceId);
        for (const inspect of [() => container!.inspect(), () => network!.inspect(), () => volume!.inspect()]) {
          await expect(inspect()).rejects.toMatchObject({ statusCode: 404 });
        }
        container = undefined;
        network = undefined;
        volume = undefined;
      } else {
        await expect(cleanupDisposableDatabase(scope, scope.resourceId, sourceResourceId)).rejects.toThrow();
        expect((await container.inspect()).Id).toBe(container.id);
        expect((await network.inspect()).Name).toBe(names.network);
        expect((await volume.inspect()).Name).toBe(names.volume);
      }
    } finally {
      // Only fixture handles are removed, including deliberately foreign-labelled ones.
      if (container) await container.remove({ force: true, v: true });
      if (network) await network.remove();
      if (volume) await volume.remove();
    }
  }, 30_000);
});
