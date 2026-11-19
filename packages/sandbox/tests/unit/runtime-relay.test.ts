import { expect, test } from "bun:test";
import { createServer, createConnection, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntimeRelay } from "../../src/deployment-runtime/relay";
async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
test("Unix ingress forwards bytes only to its fixed local application and awaits shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-relay-"));
  const application = createServer((socket) => {
    socket.on("data", (bytes) => socket.write(bytes));
  });
  const controller = new AbortController();
  try {
    await new Promise<void>((resolve) =>
      application.listen(0, "127.0.0.1", resolve),
    );
    const address = application.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port.");
    const path = join(directory, "application.sock");
    const relay = await startRuntimeRelay({
      listen: { path },
      destination: { host: "127.0.0.1", port: address.port },
      signal: controller.signal,
    });
    const received = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(path);
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("Fixture timed out"));
      });
      socket.once("error", reject);
      socket.once("connect", () => socket.write("fixture-http-bytes"));
      socket.once("data", (value) => {
        resolve(value.toString());
        socket.destroy();
      });
    });
    expect(received).toBe("fixture-http-bytes");
    controller.abort();
    await relay.close();
    await relay.close();
  } finally {
    controller.abort();
    await close(application);
    await rm(directory, { recursive: true, force: true });
  }
});
test("pre-cancelled relays never bind a listener", async () => {
  await expect(
    startRuntimeRelay({
      listen: { port: 0, host: "127.0.0.1" },
      destination: { port: 1, host: "127.0.0.1" },
      signal: AbortSignal.abort(),
    }),
  ).rejects.toThrow("could not start");
});
