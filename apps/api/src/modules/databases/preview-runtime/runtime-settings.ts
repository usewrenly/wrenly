/** Development application keys stay stable across preview revisions without entering source or saved job inputs. */
import { hkdfSync } from "node:crypto";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { appDatabases, type db } from "@wrenly/db";
import { validateAppDatabaseCredentials } from "@wrenly/db/app-database-roles";
import type { PreviewClaim } from "../../previews/persistence/preview-store";
import { assertPreviewDatabaseBinding } from "../bindings/preview-binding";
import { decryptDatabaseSecret, loadDatabaseKey } from "../database-secrets";
import { AppDatabaseError } from "../database-contract";
import { loadPreviewDatabaseConnection, type PreviewDatabaseConnection } from "./runtime-connection";
import type { RuntimeKernelFence } from "./runtime-store";

const APP_KEY_BYTES = 32;
const DEVELOPMENT_KEY_PURPOSE = "wrenly:development:laravel-app-key:v1";
export interface PreviewDatabaseApplicationSettings extends PreviewDatabaseConnection {
  appKey: string | null;
}

/** HKDF separates this Development key from the encryption key and Production's independently stored key. */
export async function loadPreviewDatabaseApplicationSettings(
  database: typeof db,
  claim: PreviewClaim,
  directory: string,
  assertKernel: RuntimeKernelFence,
): Promise<PreviewDatabaseApplicationSettings> {
  let key: Buffer | undefined;
  let derived: Buffer | undefined;
  try {
    const connection = await loadPreviewDatabaseConnection(database, claim, directory, assertKernel);
    const evidence = await assertPreviewDatabaseBinding(database, claim);
    if (evidence.binding.framework === "nextjs") return { ...connection, appKey: null };
    key = await loadDatabaseKey(join(directory, "database-keys"), true);
    await assertKernel();
    const [resource] = await database.select({ secrets: appDatabases.secrets }).from(appDatabases)
      .where(eq(appDatabases.id, evidence.binding.resourceId));
    if (!resource) throw new Error("Resource missing");
    // Authenticate this exact key against the resource before deriving; never replace a missing/wrong key.
    const credentials = validateAppDatabaseCredentials(evidence.binding.resourceId, JSON.parse(
      decryptDatabaseSecret(resource.secrets, key, `${evidence.binding.resourceId}:development`),
    ) as unknown);
    if (credentials.runtime.user !== connection.role.user || credentials.runtime.password !== connection.role.password)
      throw new Error("Runtime role changed");
    derived = Buffer.from(hkdfSync("sha256", key, Buffer.from(claim.projectId),
      Buffer.from(`${DEVELOPMENT_KEY_PURPOSE}:${evidence.binding.resourceId}`), APP_KEY_BYTES));
    await assertPreviewDatabaseBinding(database, claim);
    await assertKernel();
    return { ...connection, appKey: `base64:${derived.toString("base64")}` };
  } catch {
    throw new AppDatabaseError(409,
      "Preview application settings could not be verified. Restore the original instance database key before continuing.");
  } finally {
    derived?.fill(0);
    key?.fill(0);
  }
}
