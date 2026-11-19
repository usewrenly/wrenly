/** Only fixture-owned clients may be removed; persistent resources and foreign collisions survive. */
import { expect, test } from "bun:test";
import Docker from "dockerode";
import { cleanupProductionOperationClients } from "../src/databases/database-operation-cleanup";
import {
  databaseClientLabels,
  managedDatabaseLabels,
} from "../src/databases/database-resource-policy";
const native =
  process.env.WRENLY_TEST_PRODUCTION_CLEANUP === "true" ? test : test.skip;
native(
  "Production cleanup removes exact temporary clients and refuses foreign names",
  async () => {
    const docker = new Docker({ socketPath: "/var/run/docker.sock" });
    const projectId = crypto.randomUUID(),
      resourceId = crypto.randomUUID(),
      operationId = crypto.randomUUID();
    const source = {
      projectId,
      resourceId,
      environment: "production" as const,
    };
    const volumeName = `wrenly-cleanup-test-${operationId}`;
    await docker.createVolume({ Name: volumeName });
    const persistent = await docker.createContainer({
      Image: "postgres:17-alpine",
      Labels: managedDatabaseLabels(
        { ...source, environment: "development" },
        "database",
      ),
      HostConfig: {
        NetworkMode: "none",
        Mounts: [
          {
            Type: "volume",
            Source: volumeName,
            Target: "/var/lib/postgresql/data",
          },
        ],
      },
    });
    let client: Awaited<ReturnType<typeof docker.createContainer>> | undefined;
    let foreign: Awaited<ReturnType<typeof docker.createContainer>> | undefined;
    let fences = 0;
    try {
      client = await docker.createContainer({
        Image: "postgres:17-alpine",
        name: `wrenly-database-migration-${operationId}`,
        Labels: {
          ...databaseClientLabels(source, "database-migration"),
          "io.wrenly.database-operation-id": operationId,
        },
        HostConfig: { NetworkMode: "none" },
      });
      await cleanupProductionOperationClients({
        projectId,
        resourceId,
        operationId,
        assertHeld: async () => {
          fences++;
        },
      });
      await expect(client.inspect()).rejects.toMatchObject({ statusCode: 404 });
      expect((await persistent.inspect()).Id).toBe(persistent.id);
      expect((await docker.getVolume(volumeName).inspect()).Name).toBe(
        volumeName,
      );
      expect(fences).toBeGreaterThan(2);
      foreign = await docker.createContainer({
        Image: "postgres:17-alpine",
        name: `wrenly-database-migration-${operationId}`,
        Labels: {
          ...databaseClientLabels(
            { ...source, projectId: crypto.randomUUID() },
            "database-migration",
          ),
          "io.wrenly.database-operation-id": operationId,
        },
        HostConfig: { NetworkMode: "none" },
      });
      await expect(
        cleanupProductionOperationClients({
          projectId,
          resourceId,
          operationId,
          assertHeld: async () => {},
        }),
      ).rejects.toThrow("ownership");
      expect((await foreign.inspect()).Id).toBe(foreign.id);
      await expect(
        cleanupProductionOperationClients({
          projectId,
          resourceId: operationId,
          operationId,
          assertHeld: async () => {},
        }),
      ).rejects.toThrow("Persistent database");
    } finally {
      for (const container of [client, foreign, persistent])
        if (container)
          await container.remove({ force: true, v: true }).catch(() => {});
      await docker.getVolume(volumeName).remove();
    }
  },
  30000,
);
