/** One saved maintenance effect targets only the immutable resources of its verified publication. */
import {
  ProductionRuntimeHostRequest,
  ProductionRuntimeBrokerInspectionReply,
  ProductionRuntimeApplicationReply,
} from "@wrenly/db/production-host-contract";
import type { MaintenanceExecutionServices } from "./executor";
import type { ProductionPublishingRuntimeSecrets } from "../database-runtime/secrets";
import { executeRuntimeHostRequest } from "../../databases/production-targets/deployment-hosts/transport";
type Input = Parameters<MaintenanceExecutionServices["perform"]>[0];
/** Inspections are read-only. A stopped exact resource receives at most one start/handoff per persisted intent. */
export async function performMaintenanceHostEffect(
  input: Input & {
    credentials: ProductionPublishingRuntimeSecrets;
    framework: "nextjs" | "laravel";
    claimToken: string;
    assertHeld: () => Promise<void>;
    send?: typeof executeRuntimeHostRequest;
  },
): Promise<void> {
  const { grant, effect, signal, credentials } = input,
    b = grant.binding;
  const broker = grant.publication.completed[3]?.fact,
    app = grant.publication.completed[6]?.fact;
  if (broker?.step !== "broker-start" || app?.step !== "application-start")
    throw new Error("Saved maintenance identities are incomplete.");
  const base = {
    version: 1,
    nonce: effect.id,
    expectedDockerId: b.dockerId,
    deploymentId: b.deploymentId,
    projectId: b.projectId,
    resourceId: b.resourceId,
    claimToken: input.claimToken,
    confirmDurableIntent: true,
  };
  async function send(request: unknown): Promise<unknown> {
    await input.assertHeld();
    signal.throwIfAborted();
    return (input.send ?? executeRuntimeHostRequest)({
      ...credentials.host,
      request: ProductionRuntimeHostRequest.parse(request),
      signal,
    });
  }
  if (effect.step === "broker-start") {
    const inspection = {
      ...base,
      action: "inspect-runtime-broker",
      containerId: broker.containerId,
      imageId: broker.imageId,
      networkId: broker.networkId,
      upstream: credentials.database.upstream,
    };
    const before = ProductionRuntimeBrokerInspectionReply.parse(
      await send(inspection),
    );
    const validate = (reply: typeof before): void => {
      if (
        reply.nonce !== effect.id ||
        reply.dockerId !== b.dockerId ||
        reply.containerId !== broker.containerId ||
        reply.imageId !== broker.imageId ||
        reply.networkId !== broker.networkId ||
        reply.volumeName !== broker.volumeName
      )
        throw new Error("Maintenance broker proof changed.");
    };
    validate(before);
    if (before.running) {
      if (!before.socketReady)
        throw new Error(
          "Running broker needs inspection; credentials were not resent.",
        );
      return;
    }
    const result = ProductionRuntimeBrokerInspectionReply.parse(
      await send({
        ...base,
        action: "restart-runtime-broker",
        containerId: broker.containerId,
        imageId: broker.imageId,
        networkId: broker.networkId,
        ...credentials.database,
      }),
    );
    validate(result);
    if (!result.running || !result.socketReady)
      throw new Error("Broker restart unconfirmed.");
    return;
  }
  if (effect.step === "application-start") {
    const inspection = {
      ...base,
      action: "inspect-runtime-application",
      containerId: app.containerId,
      imageId: app.imageId,
    };
    const before = ProductionRuntimeApplicationReply.parse(
      await send(inspection),
    );
    const validate = (reply: typeof before): void => {
      if (
        reply.nonce !== effect.id ||
        reply.dockerId !== b.dockerId ||
        reply.containerId !== app.containerId ||
        reply.imageId !== app.imageId
      )
        throw new Error("Maintenance application proof changed.");
    };
    validate(before);
    if (before.running) return;
    const result = ProductionRuntimeApplicationReply.parse(
      await send({
        ...inspection,
        action: "start-runtime-application",
        framework: input.framework,
        runtimeRole: credentials.database.runtimeRole,
        appKey: input.framework === "laravel" ? credentials.appKey : null,
        brokerId: broker.containerId,
        brokerImageId: broker.imageId,
        networkId: broker.networkId,
        upstream: credentials.database.upstream,
        addresses: credentials.database.addresses,
      }),
    );
    validate(result);
    if (!result.running) throw new Error("Application restart unconfirmed.");
    return;
  }
  throw new Error(
    "Route verification requires the separately verified public route adapter.",
  );
}
