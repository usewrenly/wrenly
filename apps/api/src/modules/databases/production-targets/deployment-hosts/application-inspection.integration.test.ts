/** Creates only stopped disposable containers: no application or database credential is executed. */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRuntimeHost } from "./helper";
import {
  executeRuntimeApplicationInspection,
  inspectProductionApplicationContainer,
} from "./application-inspection";
const native =
  process.env.WRENLY_TEST_RUNTIME_APPLICATION_INSPECTION === "true"
    ? test
    : test.skip;
async function docker(args: string[], stdin?: string): Promise<string> {
  const child = Bun.spawn(
    ["docker", "--host", "unix:///var/run/docker.sock", ...args],
    {
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (stdin !== undefined && child.stdin && typeof child.stdin !== "number") {
    child.stdin.write(stdin);
    child.stdin.end();
  }
  const [output, error, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`Disposable Docker acceptance failed: ${error}`);
  return output.trim();
}
native(
  "real Docker inspection verifies guardian startup and socket mounts",
  async () => {
    const deploymentId = crypto.randomUUID(),
      projectId = crypto.randomUUID(),
      resourceId = crypto.randomUUID();
    const tag = `wrenly-inspection-fixture:${deploymentId}`;
    const directory = await mkdtemp(
      join(tmpdir(), "wrenly-inspection-fixture-"),
    );
    const http = `wrenly-deployment-http-${deploymentId}`,
      database = `wrenly-deployment-db-${deploymentId}`;
    let containerId: string | undefined;
    try {
      await docker(
        ["build", "-t", tag, "-f", "-", directory],
        'FROM oven/bun:alpine\nUSER 0:0\nLABEL io.wrenly.database-runtime-version="1"\nENTRYPOINT ["bun","--no-env-file","/wrenly/production-application.js"]\nCMD []\n',
      );
      const image = JSON.parse(await docker(["image", "inspect", tag]))[0] as {
        Id: string;
      };
      await docker(["volume", "create", http]);
      await docker(["volume", "create", database]);
      containerId = await docker([
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
        ...Object.entries({
          "io.wrenly.deployment-id": deploymentId,
          "io.wrenly.project-id": projectId,
          "io.wrenly.database-id": resourceId,
          "io.wrenly.database-environment": "production",
          "io.wrenly.role": "production-application",
        }).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        "--mount",
        `type=volume,src=${http},dst=/run/wrenly-http`,
        "--mount",
        `type=volume,src=${database},dst=/run/wrenly-database,readonly`,
        tag,
      ]);
      const info: unknown = JSON.parse(
        await docker(["inspect", containerId]),
      )[0];
      expect(
        inspectProductionApplicationContainer(info, image, {
          deploymentId,
          projectId,
          resourceId,
          containerId,
          imageId: image.Id,
        }),
      ).toEqual({ containerId, imageId: image.Id, running: false });
      const host = await inspectRuntimeHost(
        { version: 1, action: "inspect", nonce: crypto.randomUUID() },
        AbortSignal.timeout(5000),
      );
      const request = {
        version: 1,
        action: "inspect-runtime-application",
        nonce: crypto.randomUUID(),
        expectedDockerId: host.dockerId,
        deploymentId,
        projectId,
        resourceId,
        claimToken: crypto.randomUUID(),
        confirmDurableIntent: true,
        containerId,
        imageId: image.Id,
      };
      const checked = await executeRuntimeApplicationInspection(
        request,
        host.dockerId,
        AbortSignal.timeout(10000),
      );
      expect(checked.containerId).toBe(containerId);
      expect(checked.nonce).toBe(request.nonce);
      await expect(
        executeRuntimeApplicationInspection(
          { ...request, resourceId: crypto.randomUUID() },
          host.dockerId,
          AbortSignal.timeout(10000),
        ),
      ).rejects.toThrow("isolation could not be verified");
    } finally {
      if (containerId) await docker(["rm", containerId]);
      for (const name of [http, database])
        await docker(["volume", "rm", name]).catch(() => undefined);
      await docker(["image", "rm", tag]).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
