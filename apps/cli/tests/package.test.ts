import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
const PACKAGE_TIMEOUT_MS = 30_000;
async function command(args: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(args, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd },
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), PACKAGE_TIMEOUT_MS);
  try {
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`Package smoke command failed: ${error}`);
    return output;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
test(
  "packed CLI runs outside the monorepo without runtime dependencies or dotenv",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "wrenly-cli-package-"));
    try {
      const root = resolve(dirname(import.meta.path), "..");
      const stage = join(temporary, "stage"),
        outside = join(temporary, "outside");
      await mkdir(join(stage, "dist"), { recursive: true });
      await mkdir(outside);
      await copyFile(join(root, "package.json"), join(stage, "package.json"));
      await copyFile(join(root, "README.md"), join(stage, "README.md"));
      await command(
        [
          process.execPath,
          "build",
          join(root, "src/index.ts"),
          "--target=bun",
          "--env=disable",
          `--outfile=${join(stage, "dist/wrenly.js")}`,
        ],
        outside,
      );
      await command(
        [
          process.execPath,
          "pm",
          "pack",
          "--ignore-scripts",
          "--filename",
          join(temporary, "cli.tgz"),
        ],
        stage,
      );
      await command(
        ["tar", "-xzf", join(temporary, "cli.tgz"), "-C", outside],
        outside,
      );
      const manifest: {
        name: unknown;
        dependencies?: unknown;
        bin: { wrenly: string };
      } = JSON.parse(
        await readFile(join(outside, "package/package.json"), "utf8"),
      );
      expect(manifest.name).toBe("@wrenly/cli");
      expect(manifest.dependencies).toBeUndefined();
      const executable = join(outside, "package", manifest.bin.wrenly);
      expect((await stat(executable)).mode & 0o111).not.toBe(0);
      await writeFile(
        join(outside, ".env"),
        "NODE_OPTIONS=--require=/missing/should-not-load.cjs\n",
      );
      const output = await command([executable, "help"], outside);
      expect(output).toContain("read-only checks");
      expect(output).toContain("No installation or upgrade command");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  PACKAGE_TIMEOUT_MS,
);
