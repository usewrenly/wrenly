/** Adds official framework facts without granting generated code host, credential or database access. */
import Docker from "dockerode";
import { mkdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  OFFICIAL_FRAMEWORK_RELEASES,
  FRAMEWORK_INSPECTION_LIMITS,
  assertInspectionIdentity,
  parseFrameworkInspectionReport,
  type FrameworkInspectionReport,
  type InspectionFramework,
} from "@wrenly/inference/framework-tooling";
const docker = new Docker({
  socketPath: "/var/run/docker.sock",
  timeout: 10_000,
});
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const MAX_RECEIPT_BYTES = FRAMEWORK_INSPECTION_LIMITS.maximumReportBytes + 1024;
export type FrameworkInspectionReceipt =
  | { status: "available"; report: FrameworkInspectionReport }
  | { status: "unavailable"; reason: string };
export class FrameworkInspectionCleanupError extends Error {
  constructor() {
    super("Framework inspection cleanup could not be confirmed.");
    this.name = "FrameworkInspectionCleanupError";
  }
}
function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "statusCode" in error &&
    error.statusCode === 404
  );
}
async function boundedOutput(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_RECEIPT_BYTES) throw Error("Inspection output too large");
      chunks.push(result.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
/** Directory is the current sandbox's dependency-installed copy, never a browser-supplied host path. */
export async function inspectInstalledFramework(input: {
  directory: string;
  files: Array<{ path: string; content: string }>;
  framework: InspectionFramework;
  buildId: string;
  claimToken: string;
  signal: AbortSignal;
}): Promise<FrameworkInspectionReceipt> {
  if (
    !UUID.test(input.buildId) ||
    !UUID.test(input.claimToken) ||
    !input.directory.startsWith("/")
  )
    throw Error("Invalid inspection identity");
  if (input.signal.aborted) throw input.signal.reason;
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  if (uid === 0)
    return { status: "unavailable", reason: "non_root_api_required" };
  const imageName = `wrenly/framework-inspection-${input.framework}:1`;
  let image: Docker.ImageInspectInfo;
  try {
    image = await docker.getImage(imageName).inspect();
  } catch (error) {
    if (missing(error))
      return { status: "unavailable", reason: "toolchain_not_installed" };
    throw error;
  }
  if (
    image.Config.User !== "1000:1000" ||
    image.Config.Labels?.["org.wrenly.framework-inspection"] !== "1" ||
    image.Config.Labels?.["org.wrenly.framework"] !== input.framework ||
    image.Config.Labels?.["org.wrenly.upstream"] !==
      OFFICIAL_FRAMEWORK_RELEASES[input.framework].commit ||
    !/^sha256:[a-f0-9]{64}$/.test(image.Id)
  )
    return { status: "unavailable", reason: "toolchain_identity_mismatch" };
  const expected = {
    framework: input.framework,
    sourceHash: createHash("sha256")
      .update(JSON.stringify(input.files))
      .digest("hex"),
    toolchainHash: image.Id.slice(7),
  };
  if (input.framework === "nextjs") {
    const cache = join(input.directory, ".next");
    await mkdir(cache, { recursive: true });
    const stat = await lstat(cache);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error("Invalid inspection cache directory");
  }
  const name = `wrenly-framework-inspection-${crypto.randomUUID()}`;
  const labels = {
    "io.wrenly.build-id": input.buildId,
    "io.wrenly.claim-token": input.claimToken,
    "org.wrenly.module": "framework-inspection",
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let cancellation: Promise<void> | undefined;
  let cleanupFailed = false;
  let expired = false;
  const remove = async (): Promise<void> => {
    const container = docker.getContainer(name);
    try {
      const inspected = await container.inspect();
      if (
        inspected.Image !== image.Id ||
        Object.entries(labels).some(
          ([key, value]) => inspected.Config.Labels?.[key] !== value,
        )
      )
        throw Error("Inspection identity mismatch");
      await container.remove({ force: true });
    } catch (error) {
      if (!missing(error)) throw error;
    }
    try {
      await container.inspect();
      throw Error("Inspection removal unconfirmed");
    } catch (error) {
      if (!missing(error)) throw error;
    }
  };
  const cancel = (): void => {
    if (child && !cancellation)
      cancellation = remove().catch(() => {
        cleanupFailed = true;
      });
  };
  const timer = setTimeout(() => {
    expired = true;
    cancel();
  }, FRAMEWORK_INSPECTION_LIMITS.totalMilliseconds);
  input.signal.addEventListener("abort", cancel, { once: true });
  const cleanup = async (): Promise<void> => {
    try {
      await cancellation;
      await remove();
      if (cleanupFailed) throw Error("Uncertain cleanup");
    } catch {
      throw new FrameworkInspectionCleanupError();
    } finally {
      child?.kill("SIGKILL");
      await child?.exited;
    }
  };
  try {
    await docker.createContainer({
      name,
      Image: image.Id,
      User: `${uid}:${gid}`,
      WorkingDir: "/app",
      Labels: labels,
      OpenStdin: true,
      StdinOnce: false,
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Memory: 2 * 1024 ** 3,
        NanoCpus: 2_000_000_000,
        PidsLimit: 256,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        LogConfig: { Type: "none", Config: {} },
        Binds: [`${input.directory}:/app:ro`],
        Tmpfs: {
          "/tmp": `rw,nosuid,nodev,size=128m,uid=${uid},gid=${gid},mode=0700`,
          ...(input.framework === "nextjs"
            ? {
                "/app/.next": `rw,nosuid,nodev,size=512m,uid=${uid},gid=${gid},mode=0700`,
              }
            : {}),
        },
      },
    });
    if (input.signal.aborted || expired) throw Error("Inspection deadline");
    const attached = Bun.spawn(
      [
        "docker",
        "--host",
        "unix:///var/run/docker.sock",
        "start",
        "--attach",
        "--interactive",
        name,
      ],
      {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
      },
    );
    child = attached;
    await attached.stdin.write(JSON.stringify(expected) + "\n");
    await attached.stdin.flush();
    if (input.signal.aborted) cancel();
    const [code, output] = await Promise.all([
      attached.exited,
      boundedOutput(attached.stdout),
    ]);
    if (input.signal.aborted) throw input.signal.reason;
    if (code !== 0)
      return { status: "unavailable", reason: "inspection_stopped" };
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== "object" || !("status" in result))
      throw Error("Invalid inspection receipt");
    if (result.status === "unavailable")
      return {
        status: "unavailable",
        reason:
          "reason" in result &&
          typeof result.reason === "string" &&
          [
            "unsupported_version",
            "development_server_unavailable",
            "runtime_session_unavailable",
            "inspection_failed",
          ].includes(result.reason)
            ? result.reason
            : "inspection_unavailable",
      };
    if (
      result.status !== "available" ||
      !("report" in result) ||
      !result.report ||
      typeof result.report !== "object"
    )
      throw Error("Invalid inspection report");
    const report = parseFrameworkInspectionReport(result.report);
    assertInspectionIdentity(report, expected);
    return { status: "available", report };
  } catch (error) {
    if (input.signal.aborted) throw error;
    return { status: "unavailable", reason: "inspection_failed" };
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", cancel);
    await cleanup();
  }
}
