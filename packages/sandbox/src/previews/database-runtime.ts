/** Starts an already prepared database app; no installation, compilation or secret-bearing Docker configuration. */
import Docker from "dockerode";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACT_WORKSPACE_LABEL, ARTIFACT_WORKSPACE_VERSION } from "../artifacts/artifact-policy";
import { assertManagedDatabaseLabels, DATABASE_SOCKET_DIRECTORY, type ManagedDatabaseScope } from "../databases/database-resource-policy";
import type { DatabaseSocketIdentity } from "../databases/database-socket";
import { applicationDatabaseEnvironment } from "../databases/application-runtime/environment";
import { DATABASE_APPLICATION_READY } from "../databases/application-runtime/bootstrap";
import { assertPreviewDockerSupport, previewNetworkOptions } from "./network";
import { previewResourceLabels, resolvePreviewAppTarget } from "./target";
import {
  createPreviewRuntimeDirectory, waitForPreviewReadiness, PreviewRuntimeError,
  type PreviewRuntimeInput, type PreviewRuntimeResult,
} from "./runtime";

const docker = new Docker({ socketPath: "/var/run/docker.sock", timeout: 10_000 });
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
const MAX_LIFETIME_MS = 60 * 60 * 1000;
const READINESS_MS = 60_000;
const INGRESS_PORT = "8080/tcp";
const LIMITS: Docker.HostConfig = {
  Memory: 2 * 1024 ** 3, MemorySwap: 2 * 1024 ** 3, NanoCpus: 2_000_000_000, PidsLimit: 256,
  ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
  Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1", "net.ipv6.conf.default.disable_ipv6": "1" },
  Tmpfs: { "/tmp": "rw,nosuid,nodev,size=128m,uid=1000,gid=1000" },
  LogConfig: { Type: "none", Config: {} },
};

export interface PreparedDatabasePreviewInput {
  identity: PreviewRuntimeInput["identity"];
  framework: "nextjs" | "laravel";
  scope: ManagedDatabaseScope;
  imageId: string;
  socket: DatabaseSocketIdentity;
  role: { user: string; password: string };
  appKey: string | null;
  lifetimeMs: number;
  applicationBundle: Uint8Array;
  ingressBundle: Uint8Array;
  ingress: PreviewRuntimeInput["ingress"];
  signal: AbortSignal;
  assertHeld: () => Promise<void>;
  onStarted: NonNullable<PreviewRuntimeInput["onStarted"]>;
}

/** The caller records startup intent first and owns independent cleanup even when this call fails. */
export async function startPreparedDatabasePreview(request: PreparedDatabasePreviewInput): Promise<PreviewRuntimeResult> {
  const input = { ...request, identity: { ...request.identity }, scope: { ...request.scope },
    socket: { ...request.socket }, role: { ...request.role },
    ingress: { ...request.ingress, blockedCookieNames: [...request.ingress.blockedCookieNames] },
    applicationBundle: request.applicationBundle.slice(), ingressBundle: request.ingressBundle.slice() };
  let attach: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(READINESS_MS)]);
  const held = async (): Promise<void> => {
    signal.throwIfAborted();
    await input.assertHeld();
    signal.throwIfAborted();
  };
  try {
    previewResourceLabels(input.identity, "app");
    if (input.scope.environment !== "development" || input.scope.projectId !== input.identity.projectId ||
        input.socket.id !== input.identity.previewId || input.socket.projectId !== input.scope.projectId ||
        input.socket.resourceId !== input.scope.resourceId ||
        input.socket.volumeName !== `wrenly-database-socket-${input.identity.previewId}` ||
        !/^sha256:[a-f0-9]{64}$/.test(input.imageId) ||
        !Number.isSafeInteger(input.lifetimeMs) || input.lifetimeMs < 1 || input.lifetimeMs > MAX_LIFETIME_MS ||
        [input.applicationBundle, input.ingressBundle].some((bundle) => !bundle.byteLength || bundle.byteLength > MAX_BUNDLE_BYTES) ||
        (input.framework === "laravel" ? !input.appKey || !/^base64:[A-Za-z0-9+/]{43}=$/.test(input.appKey) : input.appKey !== null))
      throw new Error("Invalid database preview input");
    applicationDatabaseEnvironment(input.framework, input.scope.resourceId, input.role);
    await held();
    assertPreviewDockerSupport((await docker.version()).Version);
    const [image, socket, volume] = await Promise.all([
      docker.getImage(input.imageId).inspect(), docker.getContainer(input.socket.containerId).inspect(),
      docker.getVolume(input.socket.volumeName).inspect(),
    ]);
    if (image.Id !== input.imageId || image.Config.User !== "1000:1000" ||
        image.Config.Labels?.["io.wrenly.deployment-id"] !== input.identity.previewId ||
        image.Config.Labels?.["io.wrenly.artifact-role"] !== "runtime" ||
        image.Config.Labels?.[ARTIFACT_WORKSPACE_LABEL] !== ARTIFACT_WORKSPACE_VERSION ||
        !socket.State.Running || socket.Image !== input.socket.imageId ||
        socket.Config.Labels?.["io.wrenly.database-socket-id"] !== input.socket.id ||
        volume.Labels?.["io.wrenly.database-socket-id"] !== input.socket.id ||
        volume.Driver !== "local" || Object.keys(volume.Options ?? {}).length)
      throw new Error("Prepared image or socket ownership changed");
    assertManagedDatabaseLabels(socket.Config, input.scope, "database-socket");
    assertManagedDatabaseLabels(volume, input.scope, "database-socket");
    await held();
    const parent = await createPreviewRuntimeDirectory(input.identity);
    const bootstrap = join(parent, "application.js");
    const ingressBundle = join(parent, "ingress.js");
    await writeFile(bootstrap, input.applicationBundle, { mode: 0o644, flag: "wx" });
    await writeFile(ingressBundle, input.ingressBundle, { mode: 0o644, flag: "wx" });
    await held();
    const appNetwork = await docker.createNetwork({ ...previewNetworkOptions(input.identity.previewId),
      Labels: previewResourceLabels(input.identity, "network") });
    await held();
    const ingressNetwork = await docker.createNetwork({ Name: `wrenly-preview-ingress-${input.identity.previewId}`,
      Driver: "bridge", EnableIPv6: false, Labels: previewResourceLabels(input.identity, "network") });
    await held();
    const app = await docker.createContainer({ Image: image.Id, User: "0:0", WorkingDir: "/app",
      Entrypoint: ["bun"], Cmd: ["--no-env-file", "/wrenly/application.js"],
      Env: ["HOME=/tmp"], Labels: previewResourceLabels(input.identity, "app"),
      OpenStdin: true, StdinOnce: true, AttachStdin: true,
      HostConfig: { ...LIMITS, NetworkMode: appNetwork.id, CapAdd: ["SETUID", "SETGID"],
        Mounts: [{ Type: "bind", Source: bootstrap, Target: "/wrenly/application.js", ReadOnly: true },
          { Type: "volume", Source: volume.Name, Target: DATABASE_SOCKET_DIRECTORY, ReadOnly: true }],
        Tmpfs: { ...LIMITS.Tmpfs, ...(input.framework === "laravel" ? {
          "/app/bootstrap/cache": "rw,nosuid,nodev,size=8m,uid=1000,gid=1000",
          "/app/storage": "rw,nosuid,nodev,size=32m,uid=1000,gid=1000",
        } : {}) },
      },
    });
    await held();
    await app.start();
    await held();
    attach = Bun.spawn(["docker", "--host", "unix:///var/run/docker.sock", "attach", "--sig-proxy=false", app.id], {
      stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const activeAttach = attach;
    const stopAttach = (): void => { activeAttach.kill("SIGKILL"); };
    signal.addEventListener("abort", stopAttach, { once: true });
    try {
      await held();
      attach.stdin.write(JSON.stringify({ framework: input.framework, resourceId: input.scope.resourceId,
        role: input.role, appKey: input.appKey, lifetimeMs: input.lifetimeMs }));
      attach.stdin.end();
      const reader = attach.stdout.getReader();
      let output = "";
      try {
        while (output !== `${DATABASE_APPLICATION_READY}\n`) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error("Application exited before readiness");
          output += Buffer.from(chunk.value).toString("utf8");
          if (!`${DATABASE_APPLICATION_READY}\n`.startsWith(output)) throw new Error("Unexpected application output");
        }
      } finally { reader.releaseLock(); }
    } finally {
      signal.removeEventListener("abort", stopAttach);
      stopAttach();
      await attach.exited;
    }
    await held();
    const target = resolvePreviewAppTarget(input.identity, await app.inspect(), await appNetwork.inspect());
    const script = `import {createPreviewIngressHandler} from '/ingress.js'; Bun.serve({hostname:'0.0.0.0',port:8080,fetch:createPreviewIngressHandler(${JSON.stringify({ ...input.ingress, upstream: target })})});`;
    const ingress = await docker.createContainer({ Image: image.Id, Entrypoint: ["bun"], Cmd: ["-e", script], User: "1000:1000",
      Env: ["HOME=/tmp"], Labels: previewResourceLabels(input.identity, "ingress"), ExposedPorts: { [INGRESS_PORT]: {} },
      HostConfig: { ...LIMITS, Memory: 128 * 1024 ** 2, MemorySwap: 128 * 1024 ** 2,
        Binds: [`${ingressBundle}:/ingress.js:ro`], NetworkMode: ingressNetwork.id,
        Sysctls: { ...LIMITS.Sysctls, "net.ipv4.ip_forward": "0" },
        PortBindings: { [INGRESS_PORT]: [{ HostIp: "127.0.0.1", HostPort: "0" }] } },
    });
    await held();
    await appNetwork.connect({ Container: ingress.id });
    await held();
    await ingress.start();
    await held();
    const binding = (await ingress.inspect()).NetworkSettings.Ports[INGRESS_PORT]?.[0];
    if (binding?.HostIp !== "127.0.0.1" || !binding.HostPort || !/^\d+$/.test(binding.HostPort))
      throw new Error("Ingress loopback binding changed");
    const resources = { appContainerId: app.id, ingressContainerId: ingress.id,
      appNetworkId: appNetwork.id, ingressNetworkId: ingressNetwork.id };
    const ingressUrl = `http://127.0.0.1:${binding.HostPort}`;
    await input.onStarted(resources, { imageId: image.Id, lockfileSha256: null });
    await held();
    await waitForPreviewReadiness(ingressUrl, input.ingress, app, signal);
    await held();
    return { resources, ingressUrl, imageId: image.Id, lockfileSha256: null, output: "" };
  } catch {
    throw new PreviewRuntimeError("database application startup");
  } finally {
    attach?.kill("SIGKILL");
  }
}
