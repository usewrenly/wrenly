/** Bounded, pinned private TLS connection for trusted Production management operations only. */
import { connect, type Socket } from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "@wrenly/db/app-database-driver";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  recheckProductionDatabaseTarget,
  ProductionDestinationError,
  type PinnedProductionTarget,
  type DatabaseAddressLookup,
} from "./target-policy";
const MANAGEMENT_CONNECTION_TIMEOUT_MS = 15_000;
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
/** Runs trusted server code only; pool shutdown is awaited before the caller acknowledges an operation. */
export async function withPinnedProductionManagement<T>(input: {
  target: PinnedProductionTarget;
  credential: unknown;
  certificateAuthority?: string;
  controlDatabaseUrl: string;
  run: (database: PostgresJsDatabase) => Promise<T>;
  signal?: AbortSignal;
  lookup?: DatabaseAddressLookup;
}): Promise<T> {
  const sockets = new Set<Socket>();
  let client: ReturnType<typeof postgres> | undefined;
  const signal = AbortSignal.any([
    AbortSignal.timeout(MANAGEMENT_CONNECTION_TIMEOUT_MS),
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
        application_name: "wrenly-production-management",
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
    const result = await input.run(drizzle(client));
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
    if (client) await closeManagementClient(client);
  }
}
/** Unknown connection shutdown must not be mistaken for a confirmed remote operation. */
async function closeManagementClient(
  client: ReturnType<typeof postgres>,
): Promise<void> {
  try {
    await client.end({ timeout: 1 });
  } catch {
    throw new ProductionDestinationError();
  }
}
