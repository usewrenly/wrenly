/** Real child processes verify lock exclusion and the private control protocol without Docker. */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { acquireInstallationLock } from "../src/runtime/lock";
import { runtimeRequest } from "../src/runtime/control";
import { prepareInstallation } from "../src/install/prepare";
import { tarFixture } from "./source-fixture";
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("missing port");
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}
test("kernel lock excludes a second holder and releases explicitly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wrenly-lock-"));
  await mkdir(join(directory, ".wrenly"), { mode: 0o700 });
  try {
    const release = await acquireInstallationLock(directory);
    await expect(acquireInstallationLock(directory)).rejects.toThrow(
      "Another installation",
    );
    await release();
    await release();
    const next = await acquireInstallationLock(directory);
    await next();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("supervisor starts only its children, validates identity and stops through its private socket", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wrenly-run-")),
    directory = join(parent, "app");
  const fixture = tarFixture();
  const state = await prepareInstallation(
    {
      directory,
      webPort: await port(),
      apiPort: await port(),
      databasePort: await port(),
      previewPort: await port(),
      previews: false,
      laravel: false,
    },
    fixture.release,
    fixture.bytes,
  );
  await mkdir(join(directory, "apps/api/dist"), { recursive: true });
  await mkdir(join(directory, "apps/web/node_modules/next/dist/bin"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "apps/api/dist/index.js"),
    `Bun.serve({hostname:'127.0.0.1',port:Number(process.env.WRENLY_API_PORT),fetch:()=>Response.json({service:'wrenly-api'})});`,
  );
  await writeFile(
    join(directory, "apps/web/node_modules/next/dist/bin/next"),
    `Bun.serve({hostname:'127.0.0.1',port:Number(Bun.argv.at(-1)),fetch:()=>new Response('sign in')});`,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve(import.meta.dir, "../src/index.ts"),
      "_serve",
      directory,
      state.id,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  try {
    const deadline = Date.now() + 10000;
    let reply;
    do {
      await Bun.sleep(100);
      reply = await runtimeRequest(state, "status");
    } while (reply?.status !== "running" && Date.now() < deadline);
    expect(reply?.status).toBe("running");
    await expect(
      runtimeRequest({ ...state, id: crypto.randomUUID() }, "status"),
    ).rejects.toThrow();
    expect((await runtimeRequest(state, "stop"))?.status).toBe("stopped");
    expect(await child.exited).toBe(0);
    expect(await runtimeRequest(state, "status")).toBeNull();
  } finally {
    if (child.exitCode === null) {
      await runtimeRequest(state, "stop").catch(() => {});
      child.kill();
      await child.exited;
    }
    await rm(parent, { recursive: true, force: true });
  }
}, 20000);
