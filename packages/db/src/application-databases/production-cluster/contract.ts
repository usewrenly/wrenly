/** Project identities for the app-only Production cluster; unrelated to control-schema credentials. */
import { randomBytes } from "node:crypto";
import { z } from "zod";
const ResourceId = z.uuid().refine((value) => value === value.toLowerCase());
const Password = z.string().regex(/^[a-f0-9]{64}$/);
const Role = z
  .object({
    user: z.string().regex(/^wrenly_[a-f0-9]{32}_(migrate|runtime|reader)$/),
    password: Password,
  })
  .strict();
const Credentials = z
  .object({
    version: z.literal(1),
    database: z.string().regex(/^wrenly_[a-f0-9]{32}$/),
    migrator: Role,
    runtime: Role,
    reader: Role,
  })
  .strict();
export type ProductionProjectCredentials = z.infer<typeof Credentials>;
export interface ProductionClusterIdentity {
  appClusterId: string;
  controlClusterId: string;
}
/** Different passwords and resource-derived names prevent accidental sharing across projects or roles. */
export function validateProductionProjectCredentials(
  resourceId: string,
  input: unknown,
): ProductionProjectCredentials {
  try {
    ResourceId.parse(resourceId);
    const value = Credentials.parse(input);
    const prefix = `wrenly_${resourceId.replaceAll("-", "")}`;
    if (
      value.database !== prefix ||
      value.migrator.user !== `${prefix}_migrate` ||
      value.runtime.user !== `${prefix}_runtime` ||
      value.reader.user !== `${prefix}_reader` ||
      new Set([
        value.migrator.password,
        value.runtime.password,
        value.reader.password,
      ]).size !== 3
    )
      throw new Error("Credential identity mismatch");
    return value;
  } catch {
    throw new Error(
      "Production project credentials do not match their resource.",
    );
  }
}
/** Creates secrets once during durable admission; never call again to repair uncertain role creation. */
export function createProductionProjectCredentials(
  resourceId: string,
): ProductionProjectCredentials {
  ResourceId.parse(resourceId);
  const prefix = `wrenly_${resourceId.replaceAll("-", "")}`;
  const role = (suffix: string): { user: string; password: string } => ({
    user: `${prefix}_${suffix}`,
    password: randomBytes(32).toString("hex"),
  });
  return validateProductionProjectCredentials(resourceId, {
    version: 1,
    database: prefix,
    migrator: role("migrate"),
    runtime: role("runtime"),
    reader: role("reader"),
  });
}

/** Phase/status contracts stay browser-safe; credential generation above remains server-only. */
export {
  ProductionProvisionPhase,
  PRODUCTION_PROVISION_PHASES,
} from "../production-project-contract";
