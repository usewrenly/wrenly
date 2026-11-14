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
