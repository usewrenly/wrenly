import { describe, expect, test } from "bun:test";
import Docker from "dockerode";
import { cleanupDatabaseValidationResources } from "../src/databases/database-validation-cleanup";
import { managedDatabaseLabels } from "../src/databases/database-resource-policy";
import { cleanupOwnedRuntimeArtifact } from "../src/artifacts/runtime-artifact-cleanup";
import { cleanupScopedDatabaseSocket } from "../src/databases/database-socket";
const integration =
  process.env.WRENLY_TEST_DATABASE_VALIDATION_CLEANUP === "true"
    ? describe
    : describe.skip;
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
integration("disposable validation cleanup", () => {
  test("socket cleanup rechecks ownership before each removal and preserves an unconfirmed volume", async () => {
    const scope = {
      projectId: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
      environment: "development" as const,
    };
    const socketId = crypto.randomUUID(),
      name = `wrenly-database-socket-${socketId}`;
    const labels = {
      ...managedDatabaseLabels(scope, "database-socket"),
      "io.wrenly.database-socket-id": socketId,
    };
    const image = await docker.getImage("wrenly/postgres-runtime:17").inspect();
    let container: Docker.Container | undefined;
    let volume: Docker.Volume | undefined;
    try {
      await docker.createVolume({ Name: name, Labels: labels });
      volume = docker.getVolume(name);
      container = await docker.createContainer({
        name,
        Image: image.Id,
        Labels: labels,
        HostConfig: { NetworkMode: "none" },
      });
      await expect(
        cleanupScopedDatabaseSocket(scope, socketId, async () => {
          throw new Error("Lost claim");
        }),
      ).rejects.toThrow();
      expect((await container.inspect()).Id).toBe(container.id);
      let checks = 0;
      await expect(
        cleanupScopedDatabaseSocket(scope, socketId, async () => {
          checks++;
          if (checks === 4)
            throw new Error("Lease expired before volume removal");
        }),
      ).rejects.toThrow();
      await expect(container.inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      container = undefined;
      expect((await volume.inspect()).Name).toBe(name);
      await cleanupScopedDatabaseSocket(scope, socketId, async () => {});
      await expect(volume.inspect()).rejects.toMatchObject({ statusCode: 404 });
      volume = undefined;
    } finally {
      if (container) await container.remove({ force: true, v: true });
      if (volume) await volume.remove();
    }
  }, 30_000);
  test("artifact cleanup removes only its saved operation images and refuses live references or lost authority", async () => {
    const operationId = crypto.randomUUID();
    const foreignId = crypto.randomUUID();
    const containers: Docker.Container[] = [];
    const images: string[] = [];
    const makeImage = async (owner: string): Promise<string> => {
      const container = await docker.createContainer({
        Image: "wrenly/postgres-runtime:17",
        Labels: {
          "io.wrenly.deployment-id": owner,
          "io.wrenly.artifact-role": "preparation",
        },
        HostConfig: {
          NetworkMode: "none",
          Memory: 32 * 1024 * 1024,
          PidsLimit: 8,
        },
      });
      containers.push(container);
      const image = await container.commit({
        changes: ["LABEL io.wrenly.artifact-role=runtime"],
      });
      images.push(image.Id);
      return image.Id;
    };
    const held = async (): Promise<void> => {};
    try {
      const owned = await makeImage(operationId);
      const foreign = await makeImage(foreignId);
      await expect(
        cleanupOwnedRuntimeArtifact(operationId, async () => {
          throw new Error("Lost claim");
        }),
      ).rejects.toThrow();
      expect((await docker.getImage(owned).inspect()).Id).toBe(owned);
      // A separately referenced image must not be forcibly removed by cleanup.
      const reference = await docker.createContainer({
        Image: owned,
        HostConfig: {
          NetworkMode: "none",
          Memory: 32 * 1024 * 1024,
          PidsLimit: 8,
        },
      });
      containers.push(reference);
      await expect(
        cleanupOwnedRuntimeArtifact(operationId, held),
      ).rejects.toThrow();
      expect((await docker.getImage(owned).inspect()).Id).toBe(owned);
      await reference.remove({ v: true });
      await cleanupOwnedRuntimeArtifact(operationId, held);
      await expect(docker.getImage(owned).inspect()).rejects.toMatchObject({
        statusCode: 404,
      });
      expect((await docker.getImage(foreign).inspect()).Id).toBe(foreign);
    } finally {
      for (const container of containers)
        await container
          .remove({ force: true, v: true })
          .catch((error: unknown) => {
            if (!(
              typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              error.statusCode === 404
            ))
              throw error;
          });
      for (const image of images)
        await docker
          .getImage(image)
          .remove({ force: false })
          .catch((error: unknown) => {
            if (!(
              typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              error.statusCode === 404
            ))
              throw error;
          });
    }
  }, 30_000);
  test("removes running owned helpers, preserves source data and refuses foreign names or lost authority", async () => {
    const operationId = crypto.randomUUID(),
      sourceId = crypto.randomUUID(),
      projectId = crypto.randomUUID();
    const scope = {
      projectId,
      resourceId: operationId,
      environment: "development" as const,
    };
    const sourceScope = { ...scope, resourceId: sourceId };
    const imageId = (
      await docker.getImage("wrenly/postgres-runtime:17").inspect()
    ).Id;
    const containers: Docker.Container[] = [];
    let volume: Docker.Volume | undefined;
    const events: string[] = [];
    const cleanup = {
      assertHeld: async (): Promise<void> => {},
      beforeCleanup: async (kind: string, id: string): Promise<void> => {
        events.push(`before:${kind}:${id}`);
      },
      acknowledgeCleanup: async (kind: string, id: string): Promise<void> => {
        events.push(`after:${kind}:${id}`);
      },
    };
    const helper = async (
      kind: "application" | "administrator" | "migration",
      foreign = false,
    ): Promise<Docker.Container> => {
      const container = await docker.createContainer({
        Image: imageId,
        name: `wrenly-database-${kind}-${operationId}`,
        Entrypoint: ["sleep"],
        Cmd: ["300"],
        User: "70:70",
        Labels: {
          ...managedDatabaseLabels(
            foreign ? { ...scope, projectId: crypto.randomUUID() } : scope,
            `database-${kind}`,
          ),
          "io.wrenly.database-operation-id": operationId,
        },
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          Memory: 32 * 1024 ** 2,
          NanoCpus: 50_000_000,
          PidsLimit: 8,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
        },
      });
      containers.push(container);
      await container.start();
      return container;
    };
    try {
      volume = await docker.createVolume({
        Name: `wrenly-database-${sourceId}-data`,
        Labels: managedDatabaseLabels(sourceScope, "database-data"),
      });
      const owned = [
        await helper("application"),
        await helper("administrator"),
        await helper("migration"),
      ];
      await cleanupDatabaseValidationResources(
        scope,
        operationId,
        sourceId,
        cleanup,
      );
      for (const container of owned)
        await expect(container.inspect()).rejects.toMatchObject({
          statusCode: 404,
        });
      expect((await volume.inspect()).Labels?.["io.wrenly.database-id"]).toBe(
        sourceId,
      );
      expect(events.filter((event) => event.startsWith("after:"))).toHaveLength(
        3,
      );
      const foreign = await helper("application", true);
      events.length = 0;
      await expect(
        cleanupDatabaseValidationResources(
          scope,
          operationId,
          sourceId,
          cleanup,
        ),
      ).rejects.toThrow("disposable validation cleanup");
      expect((await foreign.inspect()).State.Running).toBe(true);
      expect(events.some((event) => event.startsWith("after:"))).toBe(false);
      await foreign.remove({ force: true, v: true });
      const stillOwned = await helper("application");
      await expect(
        cleanupDatabaseValidationResources(scope, operationId, sourceId, {
          ...cleanup,
          assertHeld: async () => {
            throw new Error("Lease lost");
          },
        }),
      ).rejects.toThrow();
      expect((await stillOwned.inspect()).State.Running).toBe(true);
      await expect(
        cleanupDatabaseValidationResources(
          sourceScope,
          sourceId,
          sourceId,
          cleanup,
        ),
      ).rejects.toThrow();
      expect((await volume.inspect()).Name).toBe(
        `wrenly-database-${sourceId}-data`,
      );
    } finally {
      for (const container of containers) {
        try {
          await container.remove({ force: true, v: true });
        } catch (error) {
          if (!(
            typeof error === "object" &&
            error &&
            "statusCode" in error &&
            error.statusCode === 404
          ))
            throw error;
        }
      }
      if (volume) await volume.remove();
    }
  }, 30_000);
});
