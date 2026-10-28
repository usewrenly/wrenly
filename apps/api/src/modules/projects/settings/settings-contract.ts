/**
 * Project details contract shared by HTTP and persistence.
 * Owns strict bounded schemas and safe errors; consumers import these definitions rather than duplicate the write contract.
 */
import { z } from "zod";
const snapshot = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullable(),
  })
  .strict();
export const ProjectSettingsInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z
      .string()
      .max(500)
      .nullable()
      .transform((value) => (value === null || !value.trim() ? null : value)),
    expected: snapshot,
  })
  .strict();
export type SettingsInput = z.infer<typeof ProjectSettingsInput>;
export type ProjectDetails = {
  id: string;
  name: string;
  description: string | null;
  stack: string;
  createdAt: Date;
  updatedAt: Date;
  access: "private";
};
export class ProjectSettingsError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly current?: ProjectDetails,
  ) {
    super(message);
  }
}
