/** Fixed private SSH helper transport. Requests and runtime credentials travel only on stdin. */
import { lookup } from "node:dns/promises";
import { isIP, BlockList } from "node:net";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ProductionRuntimeHostTarget } from "@wrenly/db/production-host-contract";
const MAX_ADDRESSES = 16;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_KEY_BYTES = 16 * 1024;
const RESOLUTION_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 30_000;
const REMOTE_HELPER = "/usr/local/bin/wrenly-runtime-host";
const PRIVATE = new BlockList();
PRIVATE.addSubnet("10.0.0.0", 8, "ipv4");
PRIVATE.addSubnet("172.16.0.0", 12, "ipv4");
PRIVATE.addSubnet("192.168.0.0", 16, "ipv4");
export type RuntimeHostLookup = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>;
/** Resolves every answer before SSH receives a private key; public/mixed/rebound destinations are never selected. */
export async function resolveRuntimeHostAddresses(
  host: string,
  signal: AbortSignal,
  resolver: RuntimeHostLookup = (name) =>
    lookup(name, { all: true, verbatim: true }),
): Promise<string[]> {
  const deadline = AbortSignal.any([
    signal,
    AbortSignal.timeout(RESOLUTION_TIMEOUT_MS),
  ]);
  let cancelled: (() => void) | undefined;
  try {
    ProductionRuntimeHostTarget.shape.host.parse(host);
    deadline.throwIfAborted();
    const rows = await Promise.race([
      resolver(host),
      new Promise<never>((_, reject) => {
        cancelled = () => reject(new Error("Private host resolution stopped."));
        if (deadline.aborted) cancelled();
        else deadline.addEventListener("abort", cancelled, { once: true });
      }),
    ]);
    deadline.throwIfAborted();
    if (
      !rows.length ||
      rows.length > MAX_ADDRESSES ||
      rows.some(
        (row) =>
          row.family !== 4 ||
          isIP(row.address) !== 4 ||
          !PRIVATE.check(row.address, "ipv4"),
      )
    )
      throw new Error("Invalid private host addresses.");
    return [...new Set(rows.map((row) => row.address))].sort();
  } finally {
    if (cancelled) deadline.removeEventListener("abort", cancelled);
  }
}
/** Never retries an unknown remote result. The caller owns durable intent, reply validation and recovery. */
export async function executeRuntimeHostRequest(input: {
  target: ProductionRuntimeHostTarget;
  addresses: string[];
  privateKey: string;
  request: unknown;
  signal: AbortSignal;
  lookup?: RuntimeHostLookup;
}): Promise<unknown> {
  let directory: string | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(OPERATION_TIMEOUT_MS),
  ]);
  const stop = (): void => {
    if (child?.exitCode === null) child.kill("SIGKILL");
  };
  try {
    const target = ProductionRuntimeHostTarget.parse(input.target);
    const payload = JSON.stringify(input.request);
    if (
      !payload ||
      Buffer.byteLength(payload) > MAX_REQUEST_BYTES ||
      Buffer.byteLength(input.privateKey) > MAX_KEY_BYTES ||
      !/^-----BEGIN OPENSSH PRIVATE KEY-----\n[\s\S]+\n-----END OPENSSH PRIVATE KEY-----\s*$/.test(
        input.privateKey,
      )
    )
      throw new Error("Invalid host helper request.");
    const verify = async (): Promise<void> => {
      const addresses = await resolveRuntimeHostAddresses(
        target.host,
        signal,
        input.lookup,
      );
      if (
        JSON.stringify(addresses) !== JSON.stringify(input.addresses) ||
        !input.addresses.length
      )
        throw new Error("Saved host addresses changed.");
    };
    await verify();
    const address = input.addresses[0]!;
    directory = await mkdtemp(join(tmpdir(), "wrenly-runtime-host-"));
    const keyPath = join(directory, "key"),
      knownPath = join(directory, "known_hosts");
    await writeFile(keyPath, input.privateKey, { mode: 0o600, flag: "wx" });
    await writeFile(
      knownPath,
      `${target.port === 22 ? address : `[${address}]:${target.port}`} ${target.hostKey}\n`,
      { mode: 0o600, flag: "wx" },
    );
    signal.throwIfAborted();
    child = Bun.spawn(
      [
        "ssh",
        "-F",
        "/dev/null",
        "-T",
        "-p",
        String(target.port),
        "-i",
        keyPath,
        "-o",
        "BatchMode=yes",
        "-o",
        "HostKeyAlgorithms=ssh-ed25519",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "ControlMaster=no",
        "-o",
        "ControlPath=none",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "IdentityAgent=none",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ProxyCommand=none",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${knownPath}`,
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-o",
        "PasswordAuthentication=no",
        "-o",
        "KbdInteractiveAuthentication=no",
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=1",
        `${target.user}@${address}`,
        REMOTE_HELPER,
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    signal.addEventListener("abort", stop, { once: true });
    signal.throwIfAborted();
    if (!child.stdin || typeof child.stdin === "number")
      throw new Error("Host input channel unavailable.");
    child.stdin.write(payload);
    child.stdin.end();
    if (!child.stdout || typeof child.stdout === "number")
      throw new Error("Host output channel unavailable.");
    const output = child.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await output.read();
        signal.throwIfAborted();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_OUTPUT_BYTES)
          throw new Error("Host output exceeds its limit.");
        chunks.push(part.value);
      }
    } finally {
      output.releaseLock();
    }
    if ((await child.exited) !== 0)
      throw new Error("Host helper did not complete.");
    signal.throwIfAborted();
    await verify();
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error(
      "Deployment host result could not be confirmed. Inspect the saved operation before retrying.",
    );
  } finally {
    signal.removeEventListener("abort", stop);
    stop();
    if (child) await child.exited;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

/** Binds the authenticated reply to this request; a cached response cannot register another host. */
export async function inspectRemoteRuntimeHost(input: {
  target: ProductionRuntimeHostTarget;
  addresses: string[];
  privateKey: string;
  signal: AbortSignal;
  lookup?: RuntimeHostLookup;
}): Promise<
  import("@wrenly/db/production-host-contract").ProductionRuntimeHostIdentity
> {
  const nonce = crypto.randomUUID();
  try {
    const { ProductionRuntimeHostIdentity } =
      await import("@wrenly/db/production-host-contract");
    const response = ProductionRuntimeHostIdentity.parse(
      await executeRuntimeHostRequest({
        ...input,
        request: { version: 1, action: "inspect", nonce },
      }),
    );
    if (response.nonce !== nonce)
      throw new Error("Host inspection identity changed.");
    return response;
  } catch {
    throw new Error("Deployment host inspection could not be verified.");
  }
}

/** Sends an already-journaled socket-volume action and binds its reply to the exact deployment and daemon. */
export async function executeRemoteRuntimeVolumeRequest(input: {
  target: ProductionRuntimeHostTarget;
  addresses: string[];
  privateKey: string;
  request: import("@wrenly/db/production-host-contract").ProductionRuntimeVolumeRequest;
  signal: AbortSignal;
  lookup?: RuntimeHostLookup;
}): Promise<
  import("zod").infer<
    typeof import("@wrenly/db/production-host-contract").ProductionRuntimeVolumeReply
  >
> {
  try {
    const { ProductionRuntimeVolumeRequest, ProductionRuntimeVolumeReply } =
      await import("@wrenly/db/production-host-contract");
    const request = ProductionRuntimeVolumeRequest.parse(input.request);
    const reply = ProductionRuntimeVolumeReply.parse(
      await executeRuntimeHostRequest({ ...input, request }),
    );
    if (
      reply.nonce !== request.nonce ||
      reply.dockerId !== request.expectedDockerId ||
      (reply.http &&
        reply.http.name !== `wrenly-deployment-http-${request.deploymentId}`) ||
      (reply.database &&
        reply.database.name !==
          `wrenly-deployment-db-${request.deploymentId}`) ||
      (request.action === "create-http-volume" && !reply.http) ||
      (request.action === "create-database-volume" && !reply.database)
    )
      throw new Error("Host volume reply identity changed.");
    return reply;
  } catch {
    throw new Error(
      "Deployment socket volumes could not be confirmed. Inspect the saved operation before retrying.",
    );
  }
}
