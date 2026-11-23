/** Real local PostgreSQL SSL negotiation fixture; no database credentials or SQL are exchanged. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyPostgresTls } from "../tls-probe";
let directory = "",
  certificate = "";
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wrenly-production-tls-"));
  const process = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=database.internal.test",
      "-addext",
      "subjectAltName=DNS:database.internal.test",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "certificate.pem"),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await process.exited) !== 0)
    throw new Error("TLS fixture certificate generation failed");
  certificate = await readFile(join(directory, "certificate.pem"), "utf8");
});
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function fixture(
  mode: "tls" | "refuse" | "malformed" | "silent",
): Promise<{ socket: Socket; requests: Buffer[]; close(): Promise<void> }> {
  const requests: Buffer[] = [];
  const child = Bun.spawn(
    [
      "node",
      join(import.meta.dir, "fixtures/tls-server.ts"),
      mode,
      join(directory, "certificate.pem"),
      join(directory, "key.pem"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
  );
  const reader = child.stdout.getReader();
  const first = await reader.read();
  const port = Number(new TextDecoder().decode(first.value).trim());
  if (!Number.isInteger(port) || port < 1) {
    child.kill();
    throw new Error("TLS fixture unavailable");
  }
  return {
    socket: connect({ host: "127.0.0.1", port }),
    requests,
    close: async () => {
      child.stdin.end();
      const chunks: Uint8Array[] = [];
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
      if ((await child.exited) !== 0) throw new Error("TLS fixture failed");
      const values: unknown = JSON.parse(
        Buffer.concat(chunks).toString().trim(),
      );
      if (
        !Array.isArray(values) ||
        !values.every((value) => typeof value === "string")
      )
        throw new Error("Invalid fixture output");
      requests.push(...values.map((value) => Buffer.from(value, "hex")));
    },
  };
}
test("verifies a real certificate and hostname, sends no authentication and closes the connection", async () => {
  const server = await fixture("tls");
  try {
    const result = await verifyPostgresTls(
      server.socket,
      "database.internal.test",
      { certificateAuthority: certificate },
    );
    expect(result).toMatch(/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/);
    expect(server.socket.destroyed).toBe(true);
  } finally {
    await server.close();
  }
  expect(server.requests).toEqual([Buffer.from([0, 0, 0, 8, 4, 210, 22, 47])]);
});
for (const variant of [
  "wrong-host",
  "untrusted-ca",
  "refuse",
  "malformed",
  "abort",
] as const)
  test(`refuses ${variant} without plaintext fallback`, async () => {
    const server = await fixture(
      variant === "refuse" || variant === "malformed"
        ? variant
        : variant === "abort"
          ? "silent"
          : "tls",
    );
    const abort = new AbortController();
    try {
      const result = verifyPostgresTls(
        server.socket,
        variant === "wrong-host"
          ? "other.internal.test"
          : "database.internal.test",
        {
          ...(variant === "untrusted-ca"
            ? {}
            : { certificateAuthority: certificate }),
          signal: abort.signal,
        },
      );
      if (variant === "abort") abort.abort();
      await expect(result).rejects.toThrow("could not be verified");
      expect(server.socket.destroyed).toBe(true);
    } finally {
      await server.close();
    }
  });
