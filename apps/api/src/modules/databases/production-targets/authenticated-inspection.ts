/** Authenticated read-only inspection reuses the same pinned TLS connection boundary as provisioning. */
import {
  inspectProductionDatabase,
  type ProductionDatabaseInspection,
} from "@wrenly/db/production-database-inspection";
import { withPinnedProductionManagement } from "./management-connection";
import type {
  PinnedProductionTarget,
  DatabaseAddressLookup,
} from "./target-policy";
/** No mutations or credentials enter the returned facts; connection shutdown is awaited. */
export async function inspectAuthenticatedProductionTarget(input: {
  target: PinnedProductionTarget;
  credential: unknown;
  certificateAuthority?: string;
  controlDatabaseUrl: string;
  controlClusterId: string;
  signal?: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<ProductionDatabaseInspection> {
  return withPinnedProductionManagement({
    ...input,
    run: (database) =>
      inspectProductionDatabase(
        database,
        input.target.target.database,
        input.controlClusterId,
      ),
  });
}
