import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  lstat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectArchive } from "../src/install/archive";
import { verifyRelease } from "../src/install/release";
import { prepareInstallation } from "../src/install/prepare";
import { readState } from "../src/install/state";
import {
  offerSetupBrowserHandoff,
  verifyConfiguration,
} from "../src/commands/management";
import { tarFixture, REVISION } from "./source-fixture";
test("archive rejects traversal, links, reserved files and collisions before extraction", () => {
  for (const item of [
    { path: `wrenly-${REVISION}/../escape` },
    { path: `/absolute/file` },
    { path: `wrenly-${REVISION}/link`, type: "2" },
    { path: `wrenly-${REVISION}/hard`, type: "1" },
    { path: `wrenly-${REVISION}/.env` },
    { path: `wrenly-${REVISION}/PACKAGE.JSON` },
    { path: `wrenly-${REVISION}/package.json/nested` },
  ]) {
    const fixture = tarFixture([item]);
    expect(() => inspectArchive(fixture.bytes, REVISION)).toThrow();
  }
  const fixture = tarFixture();
  expect(inspectArchive(fixture.bytes, REVISION)).toHaveLength(3);
  expect(() =>
    verifyRelease(fixture.bytes, {
      ...fixture.release,
      sha256: "0".repeat(64),
    }),
  ).toThrow("verification");
});
test("preparation preserves private secrets and refuses existing destinations or symlink ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrenly-source-"));
  try {
    const directory = join(root, "instance"),
      fixture = tarFixture(),
      settings = {
        directory,
        webPort: 41000,
        apiPort: 41001,
        databasePort: 41002,
        previewPort: 41003,
        previews: false,
        laravel: false,
      };
    const state = await prepareInstallation(
      settings,
      fixture.release,
      fixture.bytes,
    );
    expect((await readState(directory)).id).toBe(state.id);
    const env = await readFile(join(directory, ".env"), "utf8");
    const auth = env.match(/WRENLY_AUTH_SECRET=([a-f0-9]{64})/)?.[1];
    expect(auth).toHaveLength(64);
    expect((await lstat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
    expect(
      await readFile(join(directory, ".wrenly/install.json"), "utf8"),
    ).not.toContain(auth!);
    await expect(
      prepareInstallation(settings, fixture.release, fixture.bytes),
    ).rejects.toThrow("already exists");
    expect(await readFile(join(directory, ".env"), "utf8")).toBe(env);
    await symlink(directory, join(root, "link"));
    await expect(
      prepareInstallation(
        { ...settings, directory: join(root, "link/child") },
        fixture.release,
        fixture.bytes,
      ),
    ).rejects.toThrow("symlinks");
    await writeFile(join(directory, ".wrenly/install.json"), "{}", {
      mode: 0o600,
    });
    await expect(readState(directory)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("databases option enables preview settings and persists development flag", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrenly-db-source-"));
  try {
    const directory = join(root, "instance"),
      fixture = tarFixture();
    const state = await prepareInstallation(
      {
        directory,
        webPort: 41000,
        apiPort: 41001,
        databasePort: 41002,
        previewPort: 41003,
        previews: false,
        laravel: false,
        databases: true,
      },
      fixture.release,
      fixture.bytes,
    );
    const saved = await readState(directory);
    expect(saved.databases).toBe(true);
    expect(saved.previews).toBe(true);
    const env = await readFile(join(directory, ".env"), "utf8");
    expect(env).toContain("WRENLY_PREVIEW_ENABLED=true\n");
    expect(env).toContain("WRENLY_APP_DATABASES_ENABLED=true\n");
    expect(env).toContain("WRENLY_PRODUCTION_DATABASES_ENABLED=false\n");
    expect(env).toContain("WRENLY_FRAMEWORK_INSPECTION_ENABLED=false\n");
    expect(env).toContain("WRENLY_DICTATION_ENABLED=false\n");
    await verifyConfiguration(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("inspection and dictation options enable Laravel, write env configuration, and pass verification", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrenly-runtime-source-"));
  try {
    const directory = join(root, "instance"),
      fixture = tarFixture();
    const state = await prepareInstallation(
      {
        directory,
        webPort: 41000,
        apiPort: 41001,
        databasePort: 41002,
        previewPort: 41003,
        previews: false,
        laravel: false,
        inspection: true,
        dictation: true,
      },
      fixture.release,
      fixture.bytes,
    );
    const saved = await readState(directory);
    expect(saved.inspection).toBe(true);
    expect(saved.laravel).toBe(true);
    expect(saved.dictation).toBe(true);
    const env = await readFile(join(directory, ".env"), "utf8");
    expect(env).toContain("WRENLY_FRAMEWORK_INSPECTION_ENABLED=true\n");
    expect(env).toContain("WRENLY_DICTATION_ENABLED=true\n");
    expect(env).toContain(
      `WRENLY_DICTATION_MODEL_PATH=${join(directory, ".wrenly", "speech", "ggml-base.bin")}\n`,
    );
    await verifyConfiguration(state);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("browser handoff never auto-opens a blank setup page or leaks tokens", async () => {
  const opened: string[] = [];
  let output = "";
  await offerSetupBrowserHandoff(41000, {
    desktop: false,
    open: async (url) => {
      opened.push(url);
      return true;
    },
    write: (text) => {
      output += text;
    },
  });
  expect(opened).toHaveLength(0);
  expect(output).toContain("http://localhost:41000/setup");
  expect(output).not.toContain("#setup=");

  output = "";
  await offerSetupBrowserHandoff(41000, {
    desktop: true,
    open: async (url) => {
      opened.push(url);
      return true;
    },
    write: (text) => {
      output += text;
    },
  });
  expect(opened).toHaveLength(0);
  expect(output).toContain("http://localhost:41000/setup");
  expect(output).not.toContain("#setup=");
});
