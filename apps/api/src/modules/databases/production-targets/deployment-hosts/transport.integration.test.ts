/** Optional local SSH fixture only; no operator SSH service, account configuration or deployment host is changed. */
import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { prepareProjectSshKey } from "../../../../../../../packages/deploy/src/secrets/ssh-keys";
import { ProductionRuntimeHostIdentity } from "@wrenly/db/production-host-contract";
import { executeRuntimeHostRequest } from "./transport";
const address = process.env.WRENLY_TEST_RUNTIME_SSH_ADDRESS;
if (address && !/^10\.0\.0\.1$/.test(address))
  throw new Error(
    "Use only the local disposable Docker bridge gateway for SSH acceptance.",
  );
const check = address ? test : test.skip;
let directory = "",
  port = 0,
  key = "",
  hostKey = "";
let server: ReturnType<typeof Bun.spawn> | undefined;
beforeAll(async () => {
  if (!address) return;
  directory = await mkdtemp(join(tmpdir(), "wrenly-ssh-acceptance-"));
  const clientKey = await prepareProjectSshKey(),
    serverKey = await prepareProjectSshKey();
  key = clientKey.privateKey;
  hostKey = serverKey.publicKey.split(" ").slice(0, 2).join(" ");
  await writeFile(join(directory, "host_key"), serverKey.privateKey, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "authorized_keys"),
    clientKey.publicKey + "\n",
    { mode: 0o600 },
  );
  const helper = join(directory, "fixture.py");
  await writeFile(
    helper,
    'import sys,json\nr=json.load(sys.stdin)\nif r.get("mode")=="oversized": print("x"*140000)\nelif r.get("mode")=="invalid": print("{")\nelse: print(json.dumps({"version":1,"nonce":r["nonce"],"dockerId":"fixture-daemon","operatingSystem":"linux","architecture":"x86_64","helperVersion":1}))\n',
  );
  const listener = Bun.listen({
    hostname: address,
    port: 0,
    socket: { data() {} },
  });
  port = listener.port;
  listener.stop(true);
  const configuration = join(directory, "sshd_config");
  await writeFile(
    configuration,
    `Port ${port}\nListenAddress ${address}\nHostKey ${join(directory, "host_key")}\nAuthorizedKeysFile ${join(directory, "authorized_keys")}\nPidFile ${join(directory, "pid")}\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPubkeyAuthentication yes\nUsePAM no\nStrictModes no\nAllowUsers ${userInfo().username}\nAllowTcpForwarding no\nX11Forwarding no\nPermitTTY no\nForceCommand /usr/bin/python3 ${helper}\n`,
    { mode: 0o600 },
  );
  server = Bun.spawn(["/usr/sbin/sshd", "-D", "-e", "-f", configuration], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null)
      throw new Error("Disposable SSH server could not start.");
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connect({ host: address, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Disposable SSH server readiness timed out.");
});
afterAll(async () => {
  if (server?.exitCode === null) server.kill("SIGKILL");
  if (server) await server.exited;
  if (directory) await rm(directory, { recursive: true, force: true });
});
check(
  "strict host-key authentication carries only bounded stdin and validates the exact reply nonce",
  async () => {
    const nonce = crypto.randomUUID();
    const output = await executeRuntimeHostRequest({
      target: {
        host: "deploy.internal.test",
        port,
        user: userInfo().username,
        hostKey,
      },
      addresses: [address!],
      privateKey: key,
      request: { version: 1, action: "inspect", nonce },
      signal: AbortSignal.timeout(10_000),
      lookup: async () => [{ address: address!, family: 4 }],
    });
    expect(ProductionRuntimeHostIdentity.parse(output).nonce).toBe(nonce);
  },
  15_000,
);
check(
  "foreign host keys, DNS changes and malformed or oversized helper output fail closed",
  async () => {
    const foreign = await prepareProjectSshKey();
    const base = {
      target: {
        host: "deploy.internal.test",
        port,
        user: userInfo().username,
        hostKey,
      },
      addresses: [address!],
      privateKey: key,
      request: { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      signal: AbortSignal.timeout(20_000),
      lookup: async () => [{ address: address!, family: 4 }],
    };
    await expect(
      executeRuntimeHostRequest({
        ...base,
        target: {
          ...base.target,
          hostKey: foreign.publicKey.split(" ").slice(0, 2).join(" "),
        },
      }),
    ).rejects.toThrow("could not be confirmed");
    await expect(
      executeRuntimeHostRequest({
        ...base,
        lookup: async () => [{ address: "10.2.3.4", family: 4 }],
      }),
    ).rejects.toThrow();
    for (const mode of ["invalid", "oversized"])
      await expect(
        executeRuntimeHostRequest({
          ...base,
          request: { ...base.request, mode },
        }),
      ).rejects.toThrow("could not be confirmed");
  },
  25_000,
);
