import {
  admitProductionProvisionReview,
  resumeProductionProvision,
} from "./project-provisioning/recovery-store";
import { accessContext } from "../../auth/access/access-context";
import { createProductionDatabaseHandlers } from "../http/production-handlers";
import { createProjectProductionCreationHandlers } from "./project-provisioning/http";
import { admitProjectProductionProvision } from "./project-provisioning/store";
import { readProjectProductionCreation } from "./project-provisioning/status";
/** Own Production setup and resource workers explicitly; importing this module enables no route or background work. */
import { deployments, productionDatabaseProvisions, type db } from "@wrenly/db";
import { logger } from "../../../lib/logger";
import type { AccessPrincipal } from "../../auth/access/access-context";
import { verifyDatabaseSchema } from "../database-store";
import { getDatabaseWorkerBundle } from "../database-worker-bundle";
import { startProductionControlWorker } from "./control-worker";
import { runInstanceProductionConnectionOnce } from "./instance/worker";
import { runRuntimeHostCheckOnce } from "./deployment-hosts/worker";
import { runProductionProvisionReviewOnce } from "./project-provisioning/recovery-worker";
import { runProjectProductionProvisionOnce } from "./project-provisioning/worker";
import { attachCompletedProductionProvision } from "./project-provisioning/handoff";
import { createProductionClusterResourceWorker } from "./data/worker";
import { createInstanceProductionHttpHandlers } from "./instance/http";
import { createRuntimeHostHttpHandlers } from "./deployment-hosts/http";
import {
  admitInstanceProductionConnection,
  readInstanceProductionConnection,
  acknowledgeInstanceConnectionCheck,
  verifyInstanceProductionConnectionSchema,
} from "./instance/store";
import {
  admitRuntimeHostConnection,
  readRuntimeHostConnection,
  acknowledgeRuntimeHostCheck,
  verifyRuntimeHostConnectionSchema,
} from "./deployment-hosts/store";
interface Configuration {
  database: typeof db;
  directory: string;
  controlDatabaseUrl: string;
  webUrl: string;
  principal: (headers: Headers) => Promise<AccessPrincipal | null>;
  verifyDeploymentServer: Parameters<
    typeof runRuntimeHostCheckOnce
  >[0]["verifyDeploymentServer"];
}
type Lifecycle = { stop: () => Promise<void> };
interface Adapters {
  verify: (input: Configuration) => Promise<void>;
  control: (input: Configuration) => Lifecycle;
  resources: (input: Configuration) => Lifecycle;
}
const defaults: Adapters = {
  verify: async (input) => {
    try {
      await verifyDatabaseSchema(input.database);
      await verifyInstanceProductionConnectionSchema(input.database);
      await verifyRuntimeHostConnectionSchema(input.database);
      await input.database.select().from(productionDatabaseProvisions).limit(0);
      await input.database
        .select({
          binding: deployments.productionDatabaseBinding,
          journal: deployments.productionRuntimeJournal,
        })
        .from(deployments)
        .limit(0);
      await getDatabaseWorkerBundle("production");
    } catch {
      throw new Error(
        "Production database prerequisites could not be verified. Apply checked-in migrations through 0048 and build the trusted API helpers before activation.",
      );
    }
  },
  control: (input) =>
    startProductionControlWorker({
      stages: {
        connection: async (signal) =>
          Boolean(
            await runInstanceProductionConnectionOnce({ ...input, signal }),
          ),
        host: async (signal) =>
          Boolean(await runRuntimeHostCheckOnce({ ...input, signal })),
        review: async (signal) =>
          Boolean(await runProductionProvisionReviewOnce({ ...input, signal })),
        handoff: async (signal) =>
          Boolean(
            await attachCompletedProductionProvision({ ...input, signal }),
          ),
        provision: async (signal) =>
          Boolean(
            await runProjectProductionProvisionOnce({ ...input, signal }),
          ),
      },
      log: (stage) =>
        logger.info("Production database control work needs review", { stage }),
    }),
  resources: (input) => createProductionClusterResourceWorker(input),
};
export interface ProductionClusterModule extends Lifecycle {
  projectDatabases: ReturnType<typeof createProductionDatabaseHandlers>;
  projectCreation: ReturnType<typeof createProjectProductionCreationHandlers>;
  instanceSetup: ReturnType<typeof createInstanceProductionHttpHandlers>;
  hostSetup: ReturnType<typeof createRuntimeHostHttpHandlers>;
}
/** Caller must own the returned stop handle and separately gate public activation; this factory does not mount routes. */
export async function startProductionClusterModule(
  input: Configuration,
  adapters: Adapters = defaults,
): Promise<ProductionClusterModule> {
  await adapters.verify(input);
  const instanceSetup = createInstanceProductionHttpHandlers(
    {
      principal: input.principal,
      admit: (actor, value) =>
        admitInstanceProductionConnection(
          input.database,
          actor,
          value,
          input.directory,
        ),
      read: (actor, id) =>
        readInstanceProductionConnection(input.database, actor, id),
      acknowledge: (actor, id) =>
        acknowledgeInstanceConnectionCheck(input.database, actor, id),
    },
    input.webUrl,
  );
  const hostSetup = createRuntimeHostHttpHandlers(
    {
      principal: input.principal,
      admit: (actor, value) =>
        admitRuntimeHostConnection(
          input.database,
          actor,
          value,
          input.directory,
        ),
      read: (actor, id) => readRuntimeHostConnection(input.database, actor, id),
      acknowledge: (actor, id) =>
        acknowledgeRuntimeHostCheck(input.database, actor, id),
    },
    input.webUrl,
  );
  const projectDatabases = createProductionDatabaseHandlers(input.database, {
    directory: input.directory,
    webUrl: input.webUrl,
    productionReader: { controlDatabaseUrl: input.controlDatabaseUrl },
    productionManagement: true,
    userId: async (headers) => {
      const principal = await input.principal(headers);
      const context = accessContext.getStore();
      if (!context) throw new Error("Database HTTP request scope is missing.");
      context.principal = principal ?? undefined;
      return principal?.userId ?? null;
    },
  });
  const projectCreation = createProjectProductionCreationHandlers(
    {
      principal: input.principal,
      recover: async (actor, id, value) => {
        if (value.kind === "inspect") {
          const { kind, resourceId, ...confirmation } = value;
          return {
            kind,
            receipt: await admitProductionProvisionReview(
              input.database,
              actor,
              id,
              resourceId,
              confirmation,
            ),
          };
        }
        const { kind, reviewId, ...confirmation } = value;
        return {
          kind,
          receipt: await resumeProductionProvision(
            input.database,
            actor,
            id,
            reviewId,
            confirmation,
          ),
        };
      },
      admit: (actor, id, value) =>
        admitProjectProductionProvision(
          input.database,
          actor,
          id,
          value,
          input.directory,
        ),
      read: (actor, id, requestId) =>
        readProjectProductionCreation(input.database, actor, id, requestId),
    },
    input.webUrl,
  );
  let control: Lifecycle | undefined, resources: Lifecycle | undefined;
  async function cleanup(): Promise<void> {
    const results = await Promise.allSettled([
      control?.stop(),
      resources?.stop(),
    ]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error(
        "Production database worker cleanup could not be confirmed. Review saved work before restarting.",
      );
  }
  try {
    control = adapters.control(input);
    resources = adapters.resources(input);
  } catch (error) {
    await cleanup();
    throw error;
  }
  let stopping: Promise<void> | undefined;
  return {
    instanceSetup,
    hostSetup,
    projectDatabases,
    projectCreation,
    stop: () => (stopping ??= cleanup()),
  };
}
