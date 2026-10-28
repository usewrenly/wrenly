/** Loads only repository-owned worker bundles, never a generated or browser-selected entrypoint. */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
type DatabaseWorkerKind = "administrator" | "migration" | "query" | "application" | "preview";
const bundles = new Map<DatabaseWorkerKind, Promise<Uint8Array>>();
const MAX_BUNDLE_BYTES = 2 * 1024 * 1024;
async function buildBundle(kind: DatabaseWorkerKind): Promise<Uint8Array> {
  let directory: string | undefined;
  try {
    if (!import.meta.path.endsWith(".ts")) {
      const bytes = await readFile(
        fileURLToPath(new URL(`./database-${kind}-worker.js`, import.meta.url)),
      );
      if (!bytes.byteLength || bytes.byteLength > MAX_BUNDLE_BYTES)
        throw new Error("Trusted database worker bundle is invalid");
      return bytes;
    }
    directory = await mkdtemp(join(tmpdir(), "wrenly-database-bundle-"));
    const output = join(directory, "administrator.js");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "build",
        fileURLToPath(new URL(`./database-${kind}-worker.ts`, import.meta.url)),
        "--target=bun",
        "--env=disable",
        `--outfile=${output}`,
      ],
      {
        env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      if ((await child.exited) !== 0)
        throw new Error("Trusted database worker bundle could not be prepared");
    } finally {
      clearTimeout(timer);
    }
    const bytes = await readFile(output);
    if (!bytes.byteLength || bytes.byteLength > MAX_BUNDLE_BYTES)
      throw new Error("Trusted database worker bundle is invalid");
    return bytes;
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
/** Shares bounded trusted compilation across mutation and read services; failed builds are not cached. */
export function getDatabaseWorkerBundle(
  kind: DatabaseWorkerKind,
): Promise<Uint8Array> {
  let bundle = bundles.get(kind);
  if (!bundle) {
    bundle = buildBundle(kind).catch(() => {
      bundles.delete(kind);
      throw new Error(
        "Trusted database worker bundle is unavailable. Build the API before starting it.",
      );
    });
    bundles.set(kind, bundle);
  }
  return bundle;
}
