/** Live ingress/guardian checks use disposable images and a caller-owned test database socket. */
import { expect } from "bun:test";
import Docker from "dockerode";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPreparedDatabasePreview } from "../../src/previews/database-runtime";
import { cleanupPreviewRuntime } from "../../src/previews/runtime";
import type { ManagedDatabaseScope } from "../../src/databases/database-resource-policy";
import type { DatabaseSocketIdentity } from "../../src/databases/database-socket";

/** Framework drivers are real; source is a small runtime fixture rather than complete generated framework output. */
export async function verifyPreparedPreview(
  scope: ManagedDatabaseScope,
  socket: DatabaseSocketIdentity,
  role: { user: string; password: string },
): Promise<void> {
  const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });
  const directory = await mkdtemp(join(tmpdir(), "wrenly-prepared-preview-test-"));
  const bundle = async (entry: string): Promise<Uint8Array> => {
    const result = await Bun.build({ entrypoints: [entry], target: "bun", env: "disable" });
    if (!result.success || !result.outputs[0]) throw new Error("Fixture bundle failed");
    return new Uint8Array(await result.outputs[0].arrayBuffer());
  };
  try {
    const applicationBundle = await bundle(resolve(import.meta.dir, "../fixtures/database-preview-bootstrap.ts"));
    const ingressBundle = await bundle(resolve(import.meta.dir, "../../../../apps/api/src/modules/previews/gateway/preview-ingress.ts"));
    const source = join(directory, "app.js");
    await writeFile(source, await bundle(resolve(import.meta.dir, "../../../db/tests/fixtures/database-preview-app.ts")));
    const php = join(directory, "index.php");
    await writeFile(php, `<?php
      $p=new PDO('pgsql:host='.getenv('DB_HOST').';port='.getenv('DB_PORT').';dbname='.getenv('DB_DATABASE'),getenv('DB_USERNAME'),getenv('DB_PASSWORD'),[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
      if(!str_starts_with(getenv('APP_KEY'),'base64:')){http_response_code(500);exit;}
      $p->exec("INSERT INTO notes (id,body) VALUES (7,'Live Laravel preview') ON CONFLICT (id) DO UPDATE SET body=EXCLUDED.body");
      echo $p->query('SELECT body FROM notes WHERE id=7')->fetchColumn();`);
    for (const framework of ["nextjs", "laravel"] as const) {
      const identity = { previewId: socket.id, projectId: scope.projectId,
        buildId: crypto.randomUUID(), claimToken: crypto.randomUUID() };
      let imageId: string | undefined;
      let preparation: Docker.Container | undefined;
      try {
        preparation = await docker.createContainer({ Image: framework === "nextjs" ? socket.imageId : "wrenly/laravel-runtime:13-php8.4",
          User: "0:0", Entrypoint: ["sh"], Cmd: ["-ec", framework === "nextjs"
            ? "mkdir -p /app/node_modules/next/dist/bin && cp /fixture /app/node_modules/next/dist/bin/next && chmod -R a+rX /app"
            : "mkdir -p /app/public && cp /fixture /app/public/index.php && chmod -R a+rX /app"],
          HostConfig: { NetworkMode: "none", Binds: [`${framework === "nextjs" ? source : php}:/fixture:ro`],
            Memory: 256 * 1024 ** 2, NanoCpus: 500_000_000, CapDrop: ["ALL"] } });
        await preparation.start();
        expect((await preparation.wait()).StatusCode).toBe(0);
        imageId = (await preparation.commit({ changes: ["USER 1000:1000", "WORKDIR /app",
          `LABEL io.wrenly.deployment-id=${socket.id}`, "LABEL io.wrenly.artifact-role=runtime",
          "LABEL io.wrenly.artifact-workspace-version=2"] })).Id;
        const capability = "b".repeat(64);
        const appKey = framework === "laravel" ? `base64:${Buffer.alloc(32, 7).toString("base64")}` : null;
        let recorded = false;
        const input = { identity, framework, scope, socket, role, imageId, appKey,
          lifetimeMs: 30_000, applicationBundle, ingressBundle,
          ingress: { previewOrigin: "http://preview.localhost:3003", controlOrigin: "http://localhost:3000",
            capability, blockedCookieNames: ["control-session"] }, signal: AbortSignal.timeout(60_000),
          assertHeld: async (): Promise<void> => {},
          onStarted: async (): Promise<void> => { recorded = true; } };
        await expect(startPreparedDatabasePreview({ ...input, socket: { ...socket, resourceId: crypto.randomUUID() } })).rejects.toThrow();
        await expect(startPreparedDatabasePreview({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
        expect(recorded).toBe(false);
        let checks = 0;
        await expect(startPreparedDatabasePreview({ ...input, assertHeld: async (): Promise<void> => {
          if (++checks === 4) throw new Error("Lease lost after application network creation");
        } })).rejects.toThrow();
        expect(checks).toBe(4);
        // Startup must leave its uncertain partial network for the independent cleanup owner.
        expect((await docker.getNetwork(`wrenly-preview-${socket.id}`).inspect()).Internal).toBe(true);
        await cleanupPreviewRuntime(identity);
        expect((await docker.getContainer(socket.containerId).inspect()).State.Running).toBe(true);
        const runtime = await startPreparedDatabasePreview(input);
        expect(recorded).toBe(true);
        const response = await fetch(runtime.ingressUrl, { headers: {
          host: "preview.localhost:3003", "x-wrenly-preview-ingress": capability,
        } });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-wrenly-preview-upstream")).toBe("1");
        expect(await response.text()).toBe(framework === "nextjs" ? "Live preview database; uid=1000" : "Live Laravel preview");
        const denied = await fetch(runtime.ingressUrl, { headers: { host: "preview.localhost:3003" } });
        expect(denied.status).toBe(401);
        await denied.body?.cancel();
        const app = await docker.getContainer(runtime.resources.appContainerId).inspect();
        expect(JSON.stringify(app.Config)).not.toContain(role.password);
        if (appKey) expect(JSON.stringify(app.Config)).not.toContain(appKey);
        expect(app.HostConfig.ReadonlyRootfs).toBe(true);
        expect(app.HostConfig.PortBindings ?? {}).toEqual({});
        const network = await docker.getNetwork(runtime.resources.appNetworkId).inspect();
        expect(network.Internal).toBe(true);
        expect(network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"]).toBe("isolated");
        await expect(startPreparedDatabasePreview(input)).rejects.toThrow();
      } finally {
        await cleanupPreviewRuntime(identity);
        await preparation?.remove({ force: true, v: true });
        if (imageId) await docker.getImage(imageId).remove({ force: false });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
