/** Only the trusted database broker joins this network; generated application containers retain network:none. */
import { z } from "zod";
import {
  ProductionRuntimeNetworkRequest,
  ProductionRuntimeNetworkReply,
} from "@wrenly/db/production-host-contract";
import { acquireRuntimeHostLock } from "./host-lock";
import { runRuntimeHostDocker } from "./docker-command";
const Network = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  Name: z.string(),
  Driver: z.literal("bridge"),
  Scope: z.literal("local"),
  Internal: z.literal(false),
  EnableIPv6: z.literal(false),
  Attachable: z.literal(false),
  Ingress: z.literal(false),
  Labels: z.record(z.string(), z.string()),
  Options: z.record(z.string(), z.string()),
  Containers: z.record(z.string(), z.unknown()).nullable().optional(),
});
/** Caller retains durable intent until it saves this exact daemon-bound network acknowledgement. */
export async function executeRuntimeNetworkRequest(
  raw: unknown,
  dockerId: string,
  signal: AbortSignal,
): Promise<z.infer<typeof ProductionRuntimeNetworkReply>> {
  const input = ProductionRuntimeNetworkRequest.parse(raw);
  if (input.expectedDockerId !== dockerId)
    throw new Error("Deployment Docker identity changed.");
  const lock = await acquireRuntimeHostLock(input.deploymentId);
  const name = `wrenly-deployment-network-${input.deploymentId}`;
  const labels = {
    "io.wrenly.deployment-id": input.deploymentId,
    "io.wrenly.project-id": input.projectId,
    "io.wrenly.database-id": input.resourceId,
    "io.wrenly.database-environment": "production",
    "io.wrenly.role": "production-database-network",
  };
  async function inspect(): Promise<{ id: string; name: string } | null> {
    lock.assertHeld();
    signal.throwIfAborted();
    const listed = await runRuntimeHostDocker(
      [
        "network",
        "ls",
        "--filter",
        `name=^${name}$`,
        "--format",
        "{{.ID}} {{.Name}}",
        "--no-trunc",
      ],
      signal,
    );
    if (!listed) return null;
    if (
      !/^[a-f0-9]{64} /.test(listed) ||
      listed.split(" ")[1] !== name ||
      listed.includes("\n")
    )
      throw new Error("Ambiguous deployment network.");
    const value = z
      .array(Network)
      .length(1)
      .parse(
        JSON.parse(
          await runRuntimeHostDocker(["network", "inspect", name], signal),
        ),
      )[0]!;
    if (
      value.Name !== name ||
      listed !== `${value.Id} ${name}` ||
      Object.keys(value.Options).length ||
      Object.keys(value.Containers ?? {}).length ||
      Object.entries(labels).some(
        ([key, value_]) => value.Labels[key] !== value_,
      )
    )
      throw new Error("Deployment network identity changed.");
    return { id: value.Id, name };
  }
  try {
    const existing = await inspect();
    if (input.action === "create-runtime-network") {
      if (existing) throw new Error("Existing network needs inspection.");
      lock.assertHeld();
      signal.throwIfAborted();
      const id = await runRuntimeHostDocker(
        [
          "network",
          "create",
          "--driver",
          "bridge",
          ...Object.entries(labels).flatMap(([key, value]) => [
            "--label",
            `${key}=${value}`,
          ]),
          name,
        ],
        signal,
      );
      const created = await inspect();
      if (!created || created.id !== id)
        throw new Error("Network creation unconfirmed.");
    }
    const network = await inspect();
    lock.assertHeld();
    signal.throwIfAborted();
    return ProductionRuntimeNetworkReply.parse({
      version: 1,
      nonce: input.nonce,
      dockerId,
      network,
    });
  } catch {
    throw new Error(
      "Deployment broker network could not be confirmed. Inspect the saved operation before continuing.",
    );
  } finally {
    await lock.release();
  }
}
