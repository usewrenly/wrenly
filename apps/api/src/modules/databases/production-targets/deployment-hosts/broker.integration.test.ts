import {
  stopRuntimeApplication,
  stopRuntimeDatabaseBroker,
} from "./runtime-stop";
import { findRuntimeDatabaseBroker } from "./broker-discovery";
import { verifyRuntimeApplicationReady } from "./application-inspection";
import { restartRuntimeDatabaseBroker } from "./broker-restart";
/** Broker readiness is socket readiness only; upstream TLS/CRUD acceptance is a separate gate. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRuntimeApplication } from "./application-start";
import { inspectRuntimeHost } from "./helper";
import { executeRuntimeVolumeRequest } from "./volumes";
import { executeRuntimeNetworkRequest } from "./network";
import { inspectRuntimeDatabaseBroker } from "./broker-inspection";
import { createRuntimeDatabaseBroker } from "./broker";
import { runRuntimeHostDocker } from "./docker-command";
const native =
  process.env.WRENLY_TEST_RUNTIME_HOST_BROKER === "true" ? test : test.skip;
native(
  "runtime-only broker starts with credentials absent from Docker configuration",
  async () => {
    const signal = AbortSignal.timeout(60000);
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      signal,
    );
    const deploymentId = crypto.randomUUID(),
      resourceId = crypto.randomUUID();
    const base = {
      version: 1 as const,
      nonce: crypto.randomUUID(),
      expectedDockerId: host.dockerId,
      deploymentId,
      resourceId,
      projectId: crypto.randomUUID(),
      claimToken: crypto.randomUUID(),
      confirmDurableIntent: true as const,
    };
    const image = JSON.parse(
      await runRuntimeHostDocker(
        ["image", "inspect", "wrenly/database-socket:2"],
        signal,
      ),
    )[0] as { Id: string };
    const name = `wrenly-deployment-broker-${deploymentId}`,
      volumeName = `wrenly-deployment-db-${deploymentId}`,
      networkName = `wrenly-deployment-network-${deploymentId}`;
    const fixtureDirectory = await mkdtemp(
      join(tmpdir(), "wrenly-production-bootstrap-"),
    );
    const appTag = `wrenly-bootstrap-fixture:${deploymentId}`;
    let appContainerId: string | undefined;
    try {
      await executeRuntimeVolumeRequest(
        { ...base, action: "create-database-volume" },
        host.dockerId,
        signal,
      );
      const network = await executeRuntimeNetworkRequest(
        { ...base, action: "create-runtime-network" },
        host.dockerId,
        signal,
      );
      const request = {
        ...base,
        action: "create-runtime-broker",
        imageId: image.Id,
        networkId: network.network!.id,
        upstream: {
          hostname: "fixture.internal.test",
          address: "10.0.0.1",
          port: 9,
        },
        addresses: ["10.0.0.1"],
        runtimeRole: {
          user: `wrenly_${resourceId.replaceAll("-", "")}_runtime`,
          password: "c".repeat(64),
        },
      };
      const resolver = async () => [{ address: "10.0.0.1", family: 4 }];
      await expect(
        createRuntimeDatabaseBroker(
          {
            ...request,
            runtimeRole: {
              ...request.runtimeRole,
              user: request.runtimeRole.user.replace("runtime", "migrate"),
            },
          },
          host.dockerId,
          signal,
          resolver,
        ),
      ).rejects.toThrow("matching runtime role");
      const reply = await createRuntimeDatabaseBroker(
        request,
        host.dockerId,
        signal,
        resolver,
      );
      expect(reply.volumeName).toBe(volumeName);
      const inspectionRequest = {
        ...base,
        action: "inspect-runtime-broker",
        containerId: reply.containerId,
        imageId: image.Id,
        networkId: network.network!.id,
        upstream: request.upstream,
      };
      const checked = await inspectRuntimeDatabaseBroker(
        inspectionRequest,
        host.dockerId,
        signal,
      );
      expect(checked.socketReady).toBe(true);
      const { containerId: _savedId, ...discovery } = inspectionRequest;
      void _savedId;
      const discovered = await findRuntimeDatabaseBroker(
        { ...discovery, action: "find-runtime-broker" },
        host.dockerId,
        signal,
      );
      expect(discovered.containerId).toBe(reply.containerId);
      expect(discovered.socketReady).toBe(true);
      await expect(
        findRuntimeDatabaseBroker(
          {
            ...discovery,
            action: "find-runtime-broker",
            projectId: crypto.randomUUID(),
          },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow("could not be discovered");
      const build = Bun.spawn(
        [
          "bun",
          "build",
          join(
            import.meta.dir,
            "../../../../../../../packages/sandbox/src/deployment-runtime/application-entry.mts",
          ),
          "--target=bun",
          "--env=disable",
          `--outfile=${join(fixtureDirectory, "guardian.js")}`,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      if ((await build.exited) !== 0)
        throw new Error("Guardian acceptance bundle failed.");
      await Bun.write(
        join(fixtureDirectory, "next.js"),
        'if(process.getuid()!==1000||process.env.PGPASSWORD!=="' +
          "c".repeat(64) +
          '")process.exit(1); Bun.serve({hostname:"127.0.0.1",port:3000,fetch:()=>new Response("ready")});',
      );
      await Bun.write(
        join(fixtureDirectory, "Dockerfile"),
        'FROM oven/bun:alpine\nUSER 0:0\nWORKDIR /app\nCOPY guardian.js /wrenly/production-application.js\nCOPY next.js /app/node_modules/next/dist/bin/next\nLABEL io.wrenly.database-runtime-version="1"\nENTRYPOINT ["bun","--no-env-file","/wrenly/production-application.js"]\nCMD []\n',
      );
      const imageBuild = Bun.spawn(
        [
          "docker",
          "--host",
          "unix:///var/run/docker.sock",
          "build",
          "-t",
          appTag,
          fixtureDirectory,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const imageBuildError = await new Response(imageBuild.stderr).text();
      if ((await imageBuild.exited) !== 0)
        throw new Error(`Disposable image build failed: ${imageBuildError}`);
      const appImage = JSON.parse(
        await runRuntimeHostDocker(["image", "inspect", appTag], signal),
      )[0] as { Id: string };
      await executeRuntimeVolumeRequest(
        { ...base, action: "create-http-volume" },
        host.dockerId,
        signal,
      );
      appContainerId = await runRuntimeHostDocker(
        [
          "create",
          "--network",
          "none",
          "--read-only",
          "--interactive",
          "--memory",
          "2g",
          "--cpus",
          "2",
          "--pids-limit",
          "256",
          "--cap-drop",
          "ALL",
          "--cap-add",
          "SETUID",
          "--cap-add",
          "SETGID",
          "--cap-add",
          "CHOWN",
          "--security-opt",
          "no-new-privileges:true",
          "--restart",
          "no",
          "--tmpfs",
          "/run/wrenly-bootstrap:rw,noexec,nosuid,nodev,size=1m,uid=0,gid=0,mode=0700",
          "--tmpfs",
          "/tmp:rw,noexec,nosuid,size=16m,uid=1000,gid=1000",
          ...Object.entries({
            "io.wrenly.deployment-id": deploymentId,
            "io.wrenly.project-id": base.projectId,
            "io.wrenly.database-id": resourceId,
            "io.wrenly.database-environment": "production",
            "io.wrenly.role": "production-application",
          }).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
          "--mount",
          `type=volume,src=wrenly-deployment-http-${deploymentId},dst=/run/wrenly-http`,
          "--mount",
          `type=volume,src=${volumeName},dst=/run/wrenly-database,readonly`,
          appTag,
        ],
        signal,
      );
      const start = {
        ...base,
        action: "start-runtime-application",
        containerId: appContainerId,
        imageId: appImage.Id,
        framework: "nextjs",
        runtimeRole: request.runtimeRole,
        appKey: null,
        brokerId: reply.containerId,
        brokerImageId: image.Id,
        networkId: network.network!.id,
        upstream: request.upstream,
        addresses: request.addresses,
      };
      const readyRequest = {
        ...base,
        action: "verify-runtime-application-ready",
        containerId: appContainerId,
        imageId: appImage.Id,
      };
      await expect(
        verifyRuntimeApplicationReady(readyRequest, host.dockerId, signal),
      ).rejects.toThrow("could not be proved");
      await runRuntimeHostDocker(["start", appContainerId], signal);
      await expect(
        verifyRuntimeApplicationReady(readyRequest, host.dockerId, signal),
      ).rejects.toThrow("could not be proved");
      expect(
        (await startRuntimeApplication(start, host.dockerId, signal, resolver))
          .running,
      ).toBe(true);
      expect(
        (
          await verifyRuntimeApplicationReady(
            readyRequest,
            host.dockerId,
            signal,
          )
        ).ready,
      ).toBe(true);
      await expect(
        stopRuntimeApplication(
          {
            ...readyRequest,
            action: "stop-runtime-application",
            projectId: crypto.randomUUID(),
          },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow();
      const appStopped = await stopRuntimeApplication(
        { ...readyRequest, action: "stop-runtime-application" },
        host.dockerId,
        signal,
      );
      expect(appStopped.containerId).toBe(appContainerId);
      expect(appStopped.running).toBe(false);
      expect(
        (await startRuntimeApplication(start, host.dockerId, signal, resolver))
          .running,
      ).toBe(true);
      const appInspection = await runRuntimeHostDocker(
        ["container", "inspect", appContainerId],
        signal,
      );
      expect(appInspection).not.toContain(request.runtimeRole.password);
      await expect(
        startRuntimeApplication(start, host.dockerId, signal, resolver),
      ).rejects.toThrow("could not be confirmed");

      await expect(
        inspectRuntimeDatabaseBroker(
          { ...inspectionRequest, projectId: crypto.randomUUID() },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow("No credentials were resent");

      const inspection = await runRuntimeHostDocker(
        ["container", "inspect", reply.containerId],
        signal,
      );
      expect(inspection).not.toContain(request.runtimeRole.password);
      const info = JSON.parse(inspection)[0] as {
        State: { Health: { Status: string } };
        HostConfig: { LogConfig: { Type: string }; NetworkMode: string };
      };
      expect(info.State.Health.Status).toBe("healthy");
      expect(info.HostConfig.LogConfig.Type).toBe("none");
      expect(info.HostConfig.NetworkMode).toBe(network.network!.id);
      await expect(
        createRuntimeDatabaseBroker(request, host.dockerId, signal, resolver),
      ).rejects.toThrow("could not be confirmed");
      await expect(
        stopRuntimeDatabaseBroker(
          {
            ...inspectionRequest,
            action: "stop-runtime-broker",
            projectId: crypto.randomUUID(),
          },
          host.dockerId,
          signal,
        ),
      ).rejects.toThrow();
      const brokerStopped = await stopRuntimeDatabaseBroker(
        { ...inspectionRequest, action: "stop-runtime-broker" },
        host.dockerId,
        signal,
      );
      expect(brokerStopped.containerId).toBe(reply.containerId);
      expect(brokerStopped.running).toBe(false);
      expect(
        await runRuntimeHostDocker(["volume", "inspect", volumeName], signal),
      ).toContain(volumeName);
      const stopped = await inspectRuntimeDatabaseBroker(
        inspectionRequest,
        host.dockerId,
        signal,
      );
      expect(stopped.running).toBe(false);
      expect(stopped.socketReady).toBe(false);
      const restart = {
        ...request,
        action: "restart-runtime-broker",
        containerId: reply.containerId,
      };
      await expect(
        restartRuntimeDatabaseBroker(
          { ...restart, containerId: "a".repeat(64) },
          host.dockerId,
          signal,
          resolver,
        ),
      ).rejects.toThrow("could not be confirmed");
      const restored = await restartRuntimeDatabaseBroker(
        restart,
        host.dockerId,
        signal,
        resolver,
      );
      expect(restored.containerId).toBe(reply.containerId);
      expect(restored.socketReady).toBe(true);
      await expect(
        restartRuntimeDatabaseBroker(restart, host.dockerId, signal, resolver),
      ).rejects.toThrow("could not be confirmed");
      expect(
        await runRuntimeHostDocker(
          ["container", "inspect", reply.containerId],
          signal,
        ),
      ).not.toContain(request.runtimeRole.password);
    } finally {
      const cleanup = AbortSignal.timeout(10000);
      if (appContainerId)
        await runRuntimeHostDocker(
          ["container", "rm", "--force", appContainerId],
          cleanup,
        );
      await runRuntimeHostDocker(["image", "rm", appTag], cleanup).catch(
        () => undefined,
      );
      await runRuntimeHostDocker(
        ["volume", "rm", `wrenly-deployment-http-${deploymentId}`],
        cleanup,
      ).catch(() => undefined);
      await rm(fixtureDirectory, { recursive: true, force: true });
      await runRuntimeHostDocker(
        ["container", "rm", "--force", name],
        cleanup,
      ).catch(() => undefined);
      await runRuntimeHostDocker(["volume", "rm", volumeName], cleanup).catch(
        () => undefined,
      );
      await runRuntimeHostDocker(["network", "rm", networkName], cleanup).catch(
        () => undefined,
      );
    }
  },
  60000,
);
