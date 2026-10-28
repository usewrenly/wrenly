/** Disposable labelled Docker resources only; no application is started and no operator resources are selected. */
import { describe, expect, test } from "bun:test";
import Docker from "dockerode";
import { cleanupPreviewRuntime } from "../src/previews/runtime";
import { previewResourceLabels } from "../src/previews/target";

const integration = process.env.WRENLY_TEST_PREVIEW_CLEANUP === "true" ? describe : describe.skip;
const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });

integration("preview removal ownership", () => {
  test("lease loss between deletions retains remaining resources for explicit recovery", async () => {
    const identity = {
      previewId: crypto.randomUUID(), projectId: crypto.randomUUID(),
      buildId: crypto.randomUUID(), claimToken: crypto.randomUUID(),
    };
    const labels = previewResourceLabels(identity, "app");
    let container: Docker.Container | undefined;
    let network: Docker.Network | undefined;
    let volume: Docker.Volume | undefined;
    let foreign: Docker.Volume | undefined;
    try {
      // This trusted image must already exist locally; the fixture never pulls or runs it.
      const image = await docker.getImage("postgres:17-alpine").inspect();
      const volumeName = `wrenly-cleanup-test-${identity.previewId}`;
      const foreignName = `wrenly-cleanup-foreign-test-${identity.previewId}`;
      await docker.createVolume({ Name: volumeName, Labels: labels });
      volume = docker.getVolume(volumeName);
      await docker.createVolume({ Name: foreignName,
        Labels: previewResourceLabels({ ...identity, claimToken: crypto.randomUUID() }, "app"),
      });
      foreign = docker.getVolume(foreignName);
      network = await docker.createNetwork({ Name: `wrenly-preview-cleanup-test-${identity.previewId}`, Internal: true, Labels: labels });
      container = await docker.createContainer({ Image: image.Id, Labels: labels, HostConfig: { NetworkMode: "none" } });
      await expect(cleanupPreviewRuntime(identity, async () => {
        throw new Error("Fixture claim lost before cleanup");
      })).rejects.toThrow("cleanup could not be confirmed");
      expect((await container.inspect()).Id).toBe(container.id);
      await expect(cleanupPreviewRuntime(identity, async () => {
        try { await container!.inspect(); }
        catch { throw new Error("Fixture claim lost after container deletion"); }
      })).rejects.toThrow("cleanup could not be confirmed");
      await expect(container.inspect()).rejects.toMatchObject({ statusCode: 404 });
      expect((await network.inspect()).Id).toBe(network.id);
      expect((await volume.inspect()).Name).toBe(volume.name);
      await cleanupPreviewRuntime(identity, async () => {});
      await expect(network.inspect()).rejects.toMatchObject({ statusCode: 404 });
      await expect(volume.inspect()).rejects.toMatchObject({ statusCode: 404 });
      expect((await foreign.inspect()).Name).toBe(foreign.name);
    } finally {
      if (container) await container.remove({ force: true, v: true }).catch(() => {});
      if (network) await network.remove().catch(() => {});
      if (volume) await volume.remove().catch(() => {});
      if (foreign) await foreign.remove().catch(() => {});
    }
  }, 30_000);
});
