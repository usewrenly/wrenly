/**
 * Contributor catalog capture command.
 * Explicitly fetches normalized public registry metadata and writes the bundled offline snapshot.
 * Never runs at instance startup and never reads or sends instance credentials.
 */
// Installed instances use the protected refresh endpoint, not source-file editing.
import { join } from "node:path";
import { fetchProviderCatalog } from "./provider-catalog";
if (import.meta.main) {
  try {
    const snapshot = await fetchProviderCatalog();
    await Bun.write(
      join(import.meta.dir, "provider-catalog-snapshot.json"),
      JSON.stringify(snapshot),
    );
    await Bun.write(
      Bun.stdout,
      `Updated bundled public catalog: ${snapshot.providers.length} providers, version ${snapshot.version}.\n`,
    );
  } catch (error) {
    await Bun.write(
      Bun.stderr,
      `${error instanceof Error ? error.message : "Catalog snapshot update failed."}\n`,
    );
    process.exitCode = 1;
  }
}
