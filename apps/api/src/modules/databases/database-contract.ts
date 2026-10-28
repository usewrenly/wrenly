// Validates private role credentials and generates independent server-side secrets.
// Browser-safe action contracts are shared through the pure database package subpath.
import { z } from "zod";
import { randomBytes } from "node:crypto";
const Role = z
  .object({
    user: z
      .string()
      .regex(/^wrenly_[a-f0-9]{32}_(?:admin|migrate|runtime|reader)$/),
    password: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const DatabaseCredentials = z
  .object({
    version: z.literal(1),
    database: z.literal("app"),
    administrator: Role,
    migrator: Role,
    runtime: Role,
    reader: Role,
  })
  .strict();
export type DatabaseCredentials = z.infer<typeof DatabaseCredentials>;
export { DatabaseEnvironment, DatabaseAction } from "@wrenly/db/app-database-action-contract";
export class AppDatabaseError extends Error {
  constructor(
    public readonly status: 400 | 403 | 404 | 409 | 429 | 503,
    message: string,
  ) {
    super(message);
    this.name = "AppDatabaseError";
  }
}
/** Passwords are generated server-side, never derived from account/provider credentials. */
export function createDatabaseCredentials(
  resourceId: string,
): DatabaseCredentials {
  if (!z.string().uuid().safeParse(resourceId).success)
    throw new AppDatabaseError(400, "Invalid database resource identity.");
  const prefix = `wrenly_${resourceId.replaceAll("-", "")}`;
  const role = (suffix: string): { user: string; password: string } => ({
    user: `${prefix}_${suffix}`,
    password: randomBytes(32).toString("hex"),
  });
  return DatabaseCredentials.parse({
    version: 1,
    database: "app",
    administrator: role("admin"),
    migrator: role("migrate"),
    runtime: role("runtime"),
    reader: role("reader"),
  });
}
