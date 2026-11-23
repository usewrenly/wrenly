/** Explicit setup for public disposable MCP fixtures; never reads the instance .env or database. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { laravelFixture } from "../laravel-fixture";
const MARKER = "wrenly-framework-inspection-fixtures-v1";
async function main(): Promise<void> {
  const root = resolve(process.cwd(), ".local/framework-fixtures");
  await mkdir(root, { recursive: true });
  try {
    const previous = await readFile(join(root, ".wrenly-test-owned"), "utf8");
    if (previous.trim() !== MARKER) throw Error("Foreign fixture directory");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  await writeFile(join(root, ".wrenly-test-owned"), MARKER + "\n");
  const files = [
    ...laravelFixture().map((file) => ({
      ...file,
      path: "laravel/" + file.path,
    })),
    {
      path: "nextjs/package.json",
      content: JSON.stringify({
        private: true,
        dependencies: {
          next: "16.4.3",
          react: "19.2.8",
          "react-dom": "19.2.8",
        },
      }),
    },
    {
      path: "nextjs/app/layout.js",
      content:
        "export default function Layout({children}){return <html><body>{children}</body></html>}",
    },
    {
      path: "nextjs/app/page.js",
      content:
        "export default function Page(){return <main>Framework inspection fixture</main>}",
    },
  ];
  for (const file of files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  for (const framework of ["laravel", "nextjs"] as const) {
    const containerName = `wrenly-${framework}-inspection-${randomUUID()}`;
    const args = [
      "--host",
      "unix:///var/run/docker.sock",
      "run",
      "--rm",
      "--name",
      containerName,
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "2g",
      "--cpus",
      "2",
      "--pids-limit",
      "256",
      "--env",
      "HOME=/tmp",
      "--env",
      "COMPOSER_HOME=/tmp/composer",
      "--mount",
      `type=bind,src=${join(root, framework)},dst=/app`,
      "--workdir",
      "/app",
      "--entrypoint",
      framework === "laravel" ? "composer" : "bun",
      framework === "laravel"
        ? "wrenly/laravel-runtime:13-php8.4"
        : "oven/bun:alpine",
      ...(framework === "laravel"
        ? [
            "install",
            "--no-interaction",
            "--no-plugins",
            "--no-scripts",
            "--no-dev",
            "--prefer-dist",
          ]
        : ["install", "--ignore-scripts"]),
    ];
    const child = Bun.spawn(["docker", ...args], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    try {
      if (await child.exited)
        throw Error("Public fixture dependency installation failed.");
    } finally {
      clearTimeout(timer);
      // A killed CLI does not stop its container; remove only this unique setup resource.
      const cleanup = Bun.spawn(
        [
          "docker",
          "--host",
          "unix:///var/run/docker.sock",
          "rm",
          "--force",
          containerName,
        ],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        },
      );
      await cleanup.exited;
      const remaining = Bun.spawn(
        [
          "docker",
          "--host",
          "unix:///var/run/docker.sock",
          "ps",
          "--all",
          "--quiet",
          "--filter",
          `name=^/${containerName}$`,
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        },
      );
      const output = await new Response(remaining.stdout).text();
      if ((await remaining.exited) || output.trim())
        throw Error("Fixture cleanup could not be verified.");
    }
  }
  process.stdout.write(`Public fixtures ready: ${root}\n`);
}
void main().catch(() => {
  process.stderr.write(
    "Fixture preparation failed; inspect only its disposable setup resources.\n",
  );
  process.exitCode = 1;
});
