/** Fixed Stop and read-only inspection adapters use host authentication but never decrypt an application database password. */
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  type db,
  productionRuntimeHosts,
  productionDatabaseConnections,
} from "@wrenly/db";
import {
  ProductionRuntimeHostRequest,
  ProductionRuntimeApplicationReply,
  ProductionRuntimeApplicationReadyReply,
  ProductionRuntimeBrokerInspectionReply,
} from "@wrenly/db/production-host-contract";
import type { ApiEnvironment } from "../../../config/api-environment";
import { loadDatabaseKey } from "../../databases/database-secrets";
import { openRuntimeHostCredential } from "../../databases/production-targets/deployment-hosts/credentials";
import { executeRuntimeHostRequest } from "../../databases/production-targets/deployment-hosts/transport";
import { verifyOwnerControlledProductionRoute } from "../database-runtime/route-adapter";
import { productionMaintenanceConfiguration } from "./production";
import type { OwnerRuntimeControlServices } from "./owner-control";
/** Every send is fenced by the independently journaled current-owner control; paused permission grants no background authority. */
export function createOwnerRuntimeControlServices(input: {
  database: typeof db;
  environment: ApiEnvironment;
}): OwnerRuntimeControlServices {
  return {
    perform: async (context) => {
      const { grant, attempt, effect, signal, assertHeld } = context,
        binding = grant.binding;
      await assertHeld();
      const key = await loadDatabaseKey(
        join(input.environment.WRENLY_DATA_DIR, "production-host-keys"),
        true,
      );
      const credentials = await input.database.transaction(async (tx) => {
        await context.authorize(tx);
        const [host] = await tx
          .select()
          .from(productionRuntimeHosts)
          .where(eq(productionRuntimeHosts.id, binding.hostConnectionId));
        const [server] = await tx
          .select()
          .from(productionDatabaseConnections)
          .where(eq(productionDatabaseConnections.id, binding.connectionId));
        if (
          !host ||
          host.status !== "verified" ||
          host.verified?.dockerId !== binding.dockerId ||
          host.serverId !== binding.serverId ||
          !host.pinnedAddresses?.length ||
          !server ||
          server.status !== "verified" ||
          server.verified?.clusterId !== binding.clusterId ||
          !server.pinnedAddresses?.length
        )
          throw new Error("Original host or database metadata changed.");
        return {
          host: {
            target: host.target,
            addresses: host.pinnedAddresses,
            privateKey: openRuntimeHostCredential(host.secret, host, key),
          },
          database: {
            upstream: {
              hostname: server.target.host,
              address: server.pinnedAddresses[0]!,
              port: server.target.port,
            },
          },
        };
      });
      const broker = grant.publication.completed[3]?.fact,
        app = grant.publication.completed[6]?.fact;
      if (broker?.step !== "broker-start" || app?.step !== "application-start")
        throw new Error("Original runtime identities are missing.");
      const base = {
        version: 1,
        nonce: effect.id,
        expectedDockerId: binding.dockerId,
        deploymentId: binding.deploymentId,
        projectId: binding.projectId,
        resourceId: binding.resourceId,
        claimToken: attempt.claimToken,
        confirmDurableIntent: true,
      };
      const send = async (request: unknown): Promise<unknown> => {
        await assertHeld();
        signal.throwIfAborted();
        const result = await executeRuntimeHostRequest({
          ...credentials.host,
          request: ProductionRuntimeHostRequest.parse(request),
          signal,
        });
        await assertHeld();
        return result;
      };
      const inspectBroker = async (stop: boolean): Promise<boolean> => {
        const result = ProductionRuntimeBrokerInspectionReply.parse(
          await send({
            ...base,
            action: stop ? "stop-runtime-broker" : "inspect-runtime-broker",
            containerId: broker.containerId,
            imageId: broker.imageId,
            networkId: broker.networkId,
            upstream: credentials.database.upstream,
          }),
        );
        if (
          result.nonce !== effect.id ||
          result.dockerId !== binding.dockerId ||
          result.containerId !== broker.containerId ||
          result.imageId !== broker.imageId ||
          result.networkId !== broker.networkId ||
          result.volumeName !== broker.volumeName ||
          (!stop && result.running && !result.socketReady)
        )
          throw new Error("Original broker state is not verified.");
        return result.running;
      };
      const inspectApp = async (
        stop: boolean,
        ready: boolean,
      ): Promise<boolean> => {
        const raw = await send({
          ...base,
          action: stop
            ? "stop-runtime-application"
            : ready
              ? "verify-runtime-application-ready"
              : "inspect-runtime-application",
          containerId: app.containerId,
          imageId: app.imageId,
        });
        const result = ready
          ? ProductionRuntimeApplicationReadyReply.parse(raw)
          : ProductionRuntimeApplicationReply.parse(raw);
        if (
          result.nonce !== effect.id ||
          result.dockerId !== binding.dockerId ||
          result.containerId !== app.containerId ||
          result.imageId !== app.imageId
        )
          throw new Error("Original application state is not verified.");
        return result.running;
      };
      switch (effect.step) {
        case "application-stop":
          if (await inspectApp(true, false))
            throw new Error("Application remains running.");
          return;
        case "broker-stop":
          if (await inspectBroker(true))
            throw new Error("Broker remains running.");
          return;
        case "verify-stopped":
          if ((await inspectApp(false, false)) || (await inspectBroker(false)))
            throw new Error("Runtime Stop is not verified.");
          return;
        case "broker-inspect":
          if (!(await inspectBroker(false)))
            throw new Error(
              "Broker is stopped. Use an explicitly confirmed Stop to settle an incomplete runtime.",
            );
          return;
        case "application-inspect":
          if (!(await inspectApp(false, true)))
            throw new Error("Application is stopped or not ready.");
          return;
        case "route-inspect": {
          const configuration = await productionMaintenanceConfiguration(
            input.database,
            input.environment,
            {
              id: attempt.id,
              deploymentId: binding.deploymentId,
              projectId: binding.projectId,
              token: attempt.claimToken,
              grantRevision: grant.revision,
            },
            grant,
          );
          const result = await verifyOwnerControlledProductionRoute({
            grant,
            effect,
            signal,
            credentials,
            client: configuration.client,
            images: configuration.images,
            ingressImageId: configuration.ingressImageId,
            claimToken: attempt.claimToken,
            assertHeld,
          });
          const original = grant.publication.completed.at(-1)?.fact;
          if (
            result?.step !== "route-verify" ||
            original?.step !== "route-verify" ||
            result.url !== original.url ||
            result.sourceSha256 !== original.sourceSha256
          )
            throw new Error("Original public revision is not verified.");
          return;
        }
        default:
          throw new Error(
            "Owner runtime control cannot execute a restart step.",
          );
      }
    },
  };
}
