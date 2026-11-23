/** Native exact-resource proofs use only newly labelled fixtures; no live publication or external provider is accessed. */
import { expect, test } from "bun:test";
import { inspectProductionSetupEffect } from "./setup-inspection";
import { inspectRuntimeHost } from "../../databases/production-targets/deployment-hosts/helper";
import { executeRuntimeVolumeRequest } from "../../databases/production-targets/deployment-hosts/volumes";
import { executeRuntimeNetworkRequest } from "../../databases/production-targets/deployment-hosts/network";
import {
  beginProductionPublishingEffect,
  acknowledgeProductionPublishingEffect,
  type ProductionPublishingBinding,
  type ProductionPublishingJournal,
} from "@wrenly/db/production-publishing-contract";
import { ProductionRuntimeHostRequest } from "@wrenly/db/production-host-contract";
const native =
  process.env.WRENLY_TEST_PRODUCTION_SETUP_RECOVERY === "true"
    ? test
    : test.skip;
native(
  "lost setup acknowledgements are recovered by real read-only host inspection",
  async () => {
    const signal = AbortSignal.timeout(30000),
      deploymentId = crypto.randomUUID();
    const host = await inspectRuntimeHost(
      { version: 1, action: "inspect", nonce: crypto.randomUUID() },
      signal,
    );
    const binding: ProductionPublishingBinding = {
      version: 1,
      deploymentId,
      projectId: crypto.randomUUID(),
      buildId: crypto.randomUUID(),
      resourceId: crypto.randomUUID(),
      resourceRevision: crypto.randomUUID(),
      sourceSha256: "a".repeat(64),
      schemaDigest: "b".repeat(64),
      migrationDigest: "c".repeat(64),
      connectionId: crypto.randomUUID(),
      clusterId: "123",
      hostConnectionId: crypto.randomUUID(),
      dockerId: host.dockerId,
      serverId: "fixture",
      principal: {
        userId: "fixture",
        sessionId: "fixture",
        revision: crypto.randomUUID(),
        accessRevision: crypto.randomUUID(),
      },
    };
    const token = crypto.randomUUID();
    let journal: ProductionPublishingJournal = {
      version: 1,
      pending: null,
      completed: [],
    };
    const actions: string[] = [];
    try {
      for (let index = 0; index < 3; index++) {
        journal = beginProductionPublishingEffect(
          binding,
          journal,
          token,
          new Date(),
        );
        const effect = journal.pending!;
        const base = {
          version: 1,
          nonce: effect.id,
          expectedDockerId: host.dockerId,
          deploymentId,
          projectId: binding.projectId,
          resourceId: binding.resourceId,
          claimToken: token,
          confirmDurableIntent: true,
        };
        if (index === 2)
          await executeRuntimeNetworkRequest(
            { ...base, action: "create-runtime-network" },
            host.dockerId,
            signal,
          );
        else
          await executeRuntimeVolumeRequest(
            {
              ...base,
              action:
                index === 0 ? "create-http-volume" : "create-database-volume",
            },
            host.dockerId,
            signal,
          );
        const fact = await inspectProductionSetupEffect({
          binding,
          journal,
          effect,
          signal,
          credentials: {
            host: {
              target: {
                host: "fixture.internal",
                port: 22,
                user: "fixture",
                hostKey:
                  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + "A".repeat(43),
              },
              addresses: ["10.0.0.1"],
              privateKey: "unused-local-fixture",
            },
          },
          assertHeld: async () => {},
          send: async (input) => {
            const request = ProductionRuntimeHostRequest.parse(input.request);
            actions.push(request.action);
            if (request.action === "inspect-runtime-volumes")
              return executeRuntimeVolumeRequest(
                request,
                host.dockerId,
                signal,
              );
            if (request.action === "inspect-runtime-network")
              return executeRuntimeNetworkRequest(
                request,
                host.dockerId,
                signal,
              );
            throw new Error("A mutation reached the read-only adapter.");
          },
        });
        expect(fact?.step).toBe(effect.step);
        journal = acknowledgeProductionPublishingEffect(
          binding,
          journal,
          { effect, fact, completedAt: new Date().toISOString() },
          token,
        );
        expect(journal.completed.at(-1)?.effect).toEqual(effect);
      }
      expect(actions).toEqual([
        "inspect-runtime-volumes",
        "inspect-runtime-volumes",
        "inspect-runtime-network",
      ]);
    } finally {
      for (const args of [
        ["network", "rm", `wrenly-deployment-network-${deploymentId}`],
        ["volume", "rm", `wrenly-deployment-http-${deploymentId}`],
        ["volume", "rm", `wrenly-deployment-db-${deploymentId}`],
      ]) {
        const child = Bun.spawn(
          ["docker", "--host", "unix:///var/run/docker.sock", ...args],
          { stdout: "ignore", stderr: "ignore" },
        );
        await child.exited;
      }
    }
  },
  40000,
);
