/** Converts the common database contract into Coolify-specific API calls. */
import type { DeploymentProviderClient } from "../../../http/provider-client";
import type { DatabaseProvider, DatabaseProviderIntent, DatabaseProviderResource } from "../../../databases/provider";
import { createPrivateProductionDatabase } from "./creation";
import { readPrivateProductionDatabase, findPrivateProductionDatabase } from "./inspection";
import { validateDatabaseIntent, ProductionDatabaseProviderError, type ProductionDatabaseIntent, type ProductionDatabaseIdentity } from "./contract";
const PLACEMENT_KEYS = ["providerId", "projectUuid", "serverUuid", "environmentUuid", "destinationUuid"];
function convert(input: DatabaseProviderIntent): ProductionDatabaseIntent {
  const placement = input.placement;
  if (placement.providerId !== "coolify" || Object.keys(placement).length !== PLACEMENT_KEYS.length || PLACEMENT_KEYS.some(key => !Object.hasOwn(placement, key))) throw new ProductionDatabaseProviderError("invalid_input");
  const intent = { resourceId: input.resourceId, operationId: input.operationId, projectUuid: placement.projectUuid!, serverUuid: placement.serverUuid!, environmentUuid: placement.environmentUuid!, destinationUuid: placement.destinationUuid! };
  validateDatabaseIntent(intent);
  return intent;
}
function resource(value: ProductionDatabaseIdentity): DatabaseProviderResource {
  return { remoteId: value.uuid, state: value.status, tlsConfigured: value.sslEnabled };
}
/** The API supplies a pinned provider client; registry resolution never reads secrets from placement. */
export function createCoolifyDatabaseProvider(client: DeploymentProviderClient): DatabaseProvider {
  return {
    id: "coolify",
    createStopped: async (input, credential, signal) => await createPrivateProductionDatabase(client, convert(input), credential, signal),
    inspect: async (input, remoteId, signal) => resource(await readPrivateProductionDatabase(client, remoteId, convert(input), signal)),
    find: async (input, signal) => {
      const found = await findPrivateProductionDatabase(client, convert(input), signal);
      return found ? resource(found) : null;
    },
  };
}
