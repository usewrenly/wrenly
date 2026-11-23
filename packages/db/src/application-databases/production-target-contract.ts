/** Non-secret destination identity shared by Production connection review and trusted adapters. */
import { z } from "zod";
const MAX_HOST_LENGTH = 253;
const MAX_DATABASE_LENGTH = 63;
const Host = z
  .string()
  .min(1)
  .max(MAX_HOST_LENGTH)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  );
/** A DNS hostname is retained for TLS identity; connection strings and TLS downgrades are not inputs. */
export const ProductionDatabaseTarget = z
  .object({
    version: z.literal(1),
    environment: z.literal("production"),
    host: Host,
    port: z.number().int().min(1).max(65535),
    database: z
      .string()
      .min(1)
      .max(MAX_DATABASE_LENGTH)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_-]*$/),
    sslmode: z.literal("verify-full"),
  })
  .strict();
export type ProductionDatabaseTarget = z.infer<typeof ProductionDatabaseTarget>;
