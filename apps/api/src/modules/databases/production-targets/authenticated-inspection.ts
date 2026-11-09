/** Authenticates only to the pinned private PostgreSQL target; no setup SQL is performed here. */
import { connect, type Socket } from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "@wrenly/db/app-database-driver";
import {
  inspectProductionDatabase,
  type ProductionDatabaseInspection,
} from "@wrenly/db/production-database-inspection";
import { z } from "zod";
import {
  recheckProductionDatabaseTarget,
  ProductionDestinationError,
  type PinnedProductionTarget,
  type DatabaseAddressLookup,
} from "./target-policy";
const INSPECTION_TIMEOUT_MS = 15_000;
const MAX_CA_BYTES = 32 * 1024;
const Credential = z
  .object({
    user: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
    password: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
  })
  .strict();
/** No secrets enter the returned facts. Pool shutdown is awaited before any caller may persist successful verification. */
export async function inspectAuthenticatedProductionTarget(input: {
  target: PinnedProductionTarget;
  credential: unknown;
  certificateAuthority?: string;
  controlDatabaseUrl: string;
  controlClusterId: string;
  signal?: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<ProductionDatabaseInspection> {
  const sockets = new Set<Socket>();
  let client: ReturnType<typeof postgres> | undefined;
  const signal = AbortSignal.any([
    AbortSignal.timeout(INSPECTION_TIMEOUT_MS),
    ...(input.signal ? [input.signal] : []),
  ]);
  const abort = (): void => {
    for (const socket of sockets) socket.destroy();
  };
  try {
    const credential = Credential.parse(input.credential);
    if (
      input.certificateAuthority !== undefined &&
      (!input.certificateAuthority.length ||
        Buffer.byteLength(input.certificateAuthority) > MAX_CA_BYTES)
    )
      throw new ProductionDestinationError();
    signal.throwIfAborted();
    signal.addEventListener("abort", abort, { once: true });
    const destination = await recheckProductionDatabaseTarget(
      input.target,
      input.controlDatabaseUrl,
      { lookup: input.lookup, signal },
    );
    // The installed driver's socket hook is implemented but absent from its published type declaration.
    // An intersection preserves strict typing without weakening any driver option or TLS check.
    const options: postgres.Options<{}> & { socket: () => Promise<Socket> } = {
      host: destination.target.host,
      port: destination.target.port,
      database: destination.target.database,
      user: credential.user,
      password: credential.password,
      ssl: {
        servername: destination.target.host,
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
        ...(input.certificateAuthority
          ? { ca: input.certificateAuthority }
          : {}),
      },
      max: 1,
      connect_timeout: 5,
      idle_timeout: 1,
      max_lifetime: 15,
      fetch_types: false,
      prepare: false,
      onnotice: () => {},
      connection: {
        application_name: "wrenly-production-inspection",
        statement_timeout: 5000,
      },
      socket: async () => {
        const current = await recheckProductionDatabaseTarget(
          destination,
          input.controlDatabaseUrl,
          { lookup: input.lookup, signal },
        );
        signal.throwIfAborted();
        const address = current.addresses[0];
        if (!address) throw new ProductionDestinationError();
        return await new Promise<Socket>((resolve, reject) => {
          const socket = connect({ host: address, port: current.target.port });
          sockets.add(socket);
          socket.once("close", () => {
            sockets.delete(socket);
            reject(new ProductionDestinationError());
          });
          socket.once("error", reject);
          socket.once("connect", () =>
            signal.aborted
              ? reject(new ProductionDestinationError())
              : resolve(socket),
          );
        });
      },
    };
    client = postgres(options);
    const result = await inspectProductionDatabase(
      drizzle(client),
      destination.target.database,
      input.controlClusterId,
    );
    signal.throwIfAborted();
    await recheckProductionDatabaseTarget(
      destination,
      input.controlDatabaseUrl,
      { lookup: input.lookup, signal },
    );
    return result;
  } catch {
    throw new ProductionDestinationError();
  } finally {
    signal.removeEventListener("abort", abort);
    abort();
    if (client) await closeInspectionClient(client);
  }
}
/** Unknown connection shutdown must not be mistaken for a completed setup check. */
async function closeInspectionClient(
  client: ReturnType<typeof postgres>,
): Promise<void> {
  try {
    await client.end({ timeout: 1 });
  } catch {
    throw new ProductionDestinationError();
  }
}
