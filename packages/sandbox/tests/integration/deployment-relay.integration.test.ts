/** Opt-in local Docker acceptance; all containers and volumes are disposable and labelled by this test. */
import { expect, test } from "bun:test";
import Docker from "dockerode";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const native =
  process.env.WRENLY_TEST_DEPLOYMENT_RELAY === "true" ? test : test.skip;
native(
  "a network-disabled application serves through a credential-free Unix ingress",
  async () => {
    const docker = new Docker({
      socketPath: "/var/run/docker.sock",
      timeout: 15_000,
    });
    const id = crypto.randomUUID();
    const directory = await mkdtemp(join(tmpdir(), "wrenly-relay-native-"));
    const volumeName = `wrenly-relay-test-${id}`;
    const labels = { "io.wrenly.test-relay": id };
    const containers: Docker.Container[] = [];
    let volumeCreated = false;
    try {
      const built = await Bun.build({
        entrypoints: [
          join(import.meta.dir, "../fixtures/relay-application.mts"),
        ],
        target: "bun",
      });
      if (!built.success || !built.outputs[0])
        throw new Error("Relay fixture bundle failed.");
      await Bun.write(join(directory, "app.js"), built.outputs[0]);
      const image = await docker.getImage("oven/bun:alpine").inspect();
      await docker.createVolume({ Name: volumeName, Labels: labels });
      volumeCreated = true;
      const application = await docker.createContainer({
        Image: image.Id,
        Cmd: ["bun", "/fixture/app.js"],
        User: "0:0",
        Labels: labels,
        HostConfig: {
          NetworkMode: "none",
          ReadonlyRootfs: true,
          Binds: [`${directory}:/fixture:ro`, `${volumeName}:/run/wrenly-http`],
          Memory: 128 * 1024 * 1024,
          PidsLimit: 64,
        },
      });
      containers.push(application);
      await application.start();
      const ingressImage = await docker
        .getImage("wrenly/deployment-ingress:1")
        .inspect();
      expect(ingressImage.Config.Labels?.["io.wrenly.runtime-role"]).toBe(
        "deployment-ingress",
      );
      const ingress = await docker.createContainer({
        Image: ingressImage.Id,
        User: "1000:1000",
        Labels: labels,
        HostConfig: {
          NetworkMode: "bridge",
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges:true"],
          Binds: [`${volumeName}:/run/wrenly-http:ro`],
          Memory: 128 * 1024 * 1024,
          PidsLimit: 64,
        },
      });
      containers.push(ingress);
      await ingress.start();
      let success = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        const execution = await ingress.exec({
          Cmd: [
            "bun",
            "-e",
            'try { const r=await fetch("http://127.0.0.1:3000",{signal:AbortSignal.timeout(500)}); process.exit((await r.text())==="isolated-application"?0:1) } catch { process.exit(1) }',
          ],
          AttachStdout: false,
          AttachStderr: false,
        });
        const stream = await execution.start({ Detach: false });
        stream.resume();
        await new Promise<void>((resolve) => stream.once("end", resolve));
        let inspected = await execution.inspect();
        for (let poll = 0; inspected.Running && poll < 20; poll++) {
          await Bun.sleep(25);
          inspected = await execution.inspect();
        }
        if (inspected.ExitCode === 0) {
          success = true;
          break;
        }
        await Bun.sleep(100);
      }
      expect(success).toBe(true);
      expect((await application.inspect()).HostConfig.NetworkMode).toBe("none");
      const checked = await ingress.inspect();
      expect(checked.Config.User).toBe("1000:1000");
      expect(checked.HostConfig.ReadonlyRootfs).toBe(true);
      expect(
        checked.Config.Env?.some((value) =>
          /PASSWORD|DATABASE_URL/.test(value),
        ),
      ).toBe(false);
    } catch (error) {
      for (const container of containers) {
        const info = await container.inspect();
        if (!info.State.Running) {
          const logs = await container.logs({ stdout: true, stderr: true });
          process.stderr.write(
            Buffer.isBuffer(logs)
              ? logs.toString("utf8")
              : "Relay fixture stopped.\n",
          );
        }
      }
      throw error;
    } finally {
      const results = await Promise.allSettled(
        containers.map((container) =>
          container.remove({ force: true, v: true }),
        ),
      );
      if (results.some((result) => result.status === "rejected"))
        throw new Error("Disposable relay container cleanup failed.");
      if (volumeCreated) await docker.getVolume(volumeName).remove();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
