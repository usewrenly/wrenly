/** Server-only runtime secret selection. Management/migrator/reader credentials never leave this module's local checks. */
import { eq } from "drizzle-orm";
import { join } from "node:path";
import {
  appDatabases,
  productionRuntimeHosts,
  productionDatabaseConnections,
  deploymentResources,
  type db,
} from "@wrenly/db";
import type { ProductionRuntimeHostTarget } from "@wrenly/db/production-host-contract";
import { validateProductionProjectCredentials } from "@wrenly/db/production-project-credentials";
import {
  loadDatabaseKey,
  decryptDatabaseSecret,
} from "../../databases/database-secrets";
import { openRuntimeHostCredential } from "../../databases/production-targets/deployment-hosts/credentials";
import { openProductionConnection } from "../../databases/production-targets/instance/credentials";
import { decryptDeploymentSecret } from "@wrenly/deploy/deployment-secrets";
import type { DeploymentClaim } from "../persistence/deployment-store";
import {
  loadProductionPublishingRuntime,
  lockProductionPublishingRuntime,
} from "./store";
export interface ProductionPublishingRuntimeSecrets {
  host: {
    target: ProductionRuntimeHostTarget;
    addresses: string[];
    privateKey: string;
  };
  database: {
    runtimeRole: { user: string; password: string };
    upstream: { hostname: string; address: string; port: number };
    addresses: string[];
    certificateAuthority?: string;
  };
  appKey: string | null;
}
/** Load only for a currently held publishing claim; callers pass settings over authenticated stdin and never persist/log this object. */
export async function loadProductionPublishingRuntimeSecrets(input: {
  database: typeof db;
  claim: DeploymentClaim;
  directory: string;
  deploymentEncryptionKey: string;
}): Promise<ProductionPublishingRuntimeSecrets> {
  try {
    await loadProductionPublishingRuntime(input.database, input.claim);
    const [databaseKey, hostKey, instanceKey] = await Promise.all([
      loadDatabaseKey(join(input.directory, "database-keys"), true),
      loadDatabaseKey(join(input.directory, "production-host-keys"), true),
      loadDatabaseKey(join(input.directory, "production-instance-keys"), true),
    ]);
    return await input.database.transaction(async (tx) => {
      const { binding } = await lockProductionPublishingRuntime(
        tx,
        input.claim,
      );
      const [resource] = await tx
        .select()
        .from(appDatabases)
        .where(eq(appDatabases.id, binding.resourceId));
      const [host] = await tx
        .select()
        .from(productionRuntimeHosts)
        .where(eq(productionRuntimeHosts.id, binding.hostConnectionId));
      const [server] = await tx
        .select()
        .from(productionDatabaseConnections)
        .where(eq(productionDatabaseConnections.id, binding.connectionId));
      const [placement] = await tx
        .select()
        .from(deploymentResources)
        .where(eq(deploymentResources.projectId, binding.projectId));
      if (
        !resource ||
        !host ||
        !server ||
        !placement ||
        !host.pinnedAddresses?.length ||
        !server.pinnedAddresses?.length
      )
        throw new Error("Production target unavailable.");
      const credentials = validateProductionProjectCredentials(
        resource.id,
        JSON.parse(
          decryptDatabaseSecret(
            resource.secrets,
            databaseKey,
            `${resource.id}:production`,
          ),
        ),
      );
      const management = openProductionConnection(
        server.secret,
        server,
        instanceKey,
      );
      const privateKey = openRuntimeHostCredential(host.secret, host, hostKey);
      let appKey: string | null = null;
      // The existing deployment path creates and encrypts the stable key once; this loader never invents a replacement.
      if (placement.encryptedLaravelAppKey)
        appKey = decryptDeploymentSecret(
          placement.encryptedLaravelAppKey,
          input.deploymentEncryptionKey,
          binding.projectId,
          "laravel-app-key",
        );
      return {
        host: {
          target: host.target,
          addresses: host.pinnedAddresses,
          privateKey,
        },
        database: {
          runtimeRole: credentials.runtime,
          upstream: {
            hostname: server.target.host,
            address: server.pinnedAddresses[0]!,
            port: server.target.port,
          },
          addresses: server.pinnedAddresses,
          ...(management.certificateAuthority
            ? { certificateAuthority: management.certificateAuthority }
            : {}),
        },
        appKey,
      };
    });
  } catch {
    throw new Error(
      "Production publishing credentials could not be authenticated for this execution. Restore the original keys and review its saved setup.",
    );
  }
}
