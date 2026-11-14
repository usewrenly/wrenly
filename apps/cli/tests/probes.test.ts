import { expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalProbes } from "../src/probes";
test("local probes leave an absent destination untouched and release sockets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-doctor-"));
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Fixture port unavailable");
    const probes = createLocalProbes();
    const destination = join(directory, "not-created");
    expect(await probes.destination(destination)).toBe("absent");
    expect(await probes.disk(destination)).not.toBeNull();
    expect(await probes.port(address.port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probes.port(address.port)).toBe(true);
    expect(await probes.port(address.port)).toBe(true);
    expect(
      await access(destination).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  } finally {
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
