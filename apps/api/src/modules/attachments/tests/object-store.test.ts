import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachmentObjectStore } from "../storage/object-store";

test("private attachment objects retain exact bytes and reject changed content, paths and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wrenly-attachment-"));
  try {
    const directory = join(root, "objects");
    const store = await createAttachmentObjectStore(directory);
    const object = await store.write(new TextEncoder().encode("reference"));
    expect(new TextDecoder().decode(await store.read(object))).toBe(
      "reference",
    );
    await expect(store.remove("../outside")).rejects.toThrow();
    await writeFile(join(directory, object.id), "different");
    await expect(store.read(object)).rejects.toThrow();
    await store.remove(object.id);
    await symlink(join(root, "outside"), join(directory, object.id));
    await expect(store.read(object)).rejects.toThrow();
    await store.remove(object.id);
    await store.remove(object.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
