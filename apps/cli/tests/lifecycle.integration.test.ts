/** Explicit opt-in: real source build, dedicated PostgreSQL, protected account setup and preserved restart. */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { readState, saveState } from "../src/install/state";
const integration =
  process.env.WRENLY_TEST_INSTALLER === "true" ? describe : describe.skip;
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No test port");
  await new Promise<void>((r) => server.close(() => r()));
  return address.port;
}
integration("guided installer acceptance", () => {
  test("fresh install, protected owner, preserved Stop/start and explicit Resume", async () => {
    const parent = await mkdtemp(join(homedir(), ".wrenly-test-")),
      directory = join(parent, "app"),
      bundle = join(parent, "cli");
    await mkdir(bundle, { mode: 0o700 });
    const built = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../src/index.ts")],
      target: "bun",
      env: "disable",
      outdir: bundle,
      naming: "wrenly.js",
    });
    expect(built.success).toBe(true);
    const cli = join(bundle, "wrenly.js");
    async function command(
      action: string,
      extra: string[] = [],
    ): Promise<{ code: number; output: string }> {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          cli,
          action,
          "--directory",
          directory,
          ...extra,
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
      try {
        return {
          output: await new Response(child.stdout).text(),
          code: await child.exited,
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const web = await freePort(),
      api = await freePort(),
      database = await freePort(),
      origin = `http://localhost:${web}`,
      base = `http://127.0.0.1:${api}`;
    try {
      const installed = await command("install", [
        "--web-port",
        String(web),
        "--api-port",
        String(api),
        "--database-port",
        String(database),
        "--yes",
      ]);
      if (installed.code !== 0)
        throw Error(
          "Disposable installation failed; inspect its preserved journal.",
        );
      const secretHash = createHash("sha256")
        .update(await readFile(join(directory, ".env")))
        .digest("hex");
      const setup = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          `--env-file=${join(directory, ".env")}`,
          "src/modules/auth/setup/setup-cli.ts",
        ],
        { cwd: join(directory, "apps/api"), stdout: "pipe", stderr: "ignore" },
      );
      const privateOutput = await new Response(setup.stdout).text();
      expect(await setup.exited).toBe(0);
      const proof = privateOutput.match(/#setup=([A-Za-z0-9_-]{43})/)?.[1];
      expect(Boolean(proof)).toBe(true);
      const password = crypto.randomUUID() + "Aa!";
      const claim = await fetch(base + "/api/instance/setup", {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          proof,
          requestId: crypto.randomUUID(),
          email: "installer@example.test",
          name: "Installer test",
          password,
        }),
      });
      expect(claim.status).toBe(201);
      async function signIn(): Promise<string> {
        const response = await fetch(base + "/api/auth/sign-in/email", {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ email: "installer@example.test", password }),
        });
        expect(response.ok).toBe(true);
        return response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
      }
      const cookie = await signIn();
      const created = await fetch(base + "/api/projects", {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "Preserved installer project",
          stack: "nextjs",
        }),
      });
      expect(created.ok).toBe(true);
      expect((await command("stop", ["--yes"])).code).toBe(0);
      expect((await command("start", ["--yes"])).code).toBe(0);
      const saved = (await fetch(base + "/api/projects", {
        headers: { cookie: await signIn() },
      }).then((response) => response.json())) as {
        projects: Array<{ name: string }>;
      };
      expect(
        saved.projects.some(
          (project) => project.name === "Preserved installer project",
        ),
      ).toBe(true);
      expect((await fetch(base + "/api/projects")).status).toBe(401);
      expect((await command("stop", ["--yes"])).code).toBe(0);
      // Model an acknowledgement lost at runtime startup, solely in this disposable journal.
      const state = await readState(directory);
      state.phase = "attention";
      state.steps.runtime = "unconfirmed";
      await saveState(state);
      const occupied = createServer();
      await new Promise<void>((r) => occupied.listen(web, "127.0.0.1", r));
      try {
        expect((await command("resume", ["--yes"])).code).toBe(1);
      } finally {
        await new Promise<void>((r) => occupied.close(() => r()));
      }
      expect((await readState(directory)).steps.runtime).toBe("unconfirmed");
      expect((await command("resume", ["--yes"])).code).toBe(0);
      expect(
        createHash("sha256")
          .update(await readFile(join(directory, ".env")))
          .digest("hex"),
      ).toBe(secretHash);
      await signIn();
    } finally {
      await command("stop", ["--yes"]);
      // Keep the exact volume and private directory for inspection; tests never prune storage.
      await Bun.write(
        Bun.stdout,
        `Disposable installer data preserved at ${directory}\n`,
      );
    }
  }, 360000);
});
