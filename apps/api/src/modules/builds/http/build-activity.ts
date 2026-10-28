/**
 * Public build step metadata.
 * Defines fixed operation/state values for observed work, separate from assistant answers and private model reasoning.
 * Validation prevents arbitrary tool arguments, provider diagnostics or secrets entering activity events.
 */
import { z } from "zod";
export const ActivityInputSchema = z
  .object({
    operation: z.enum(["generation", "source", "installation", "validation"]),
    state: z.enum(["started", "completed", "failed"]),
  })
  .strict();
export type BuildActivityInput = z.infer<typeof ActivityInputSchema>;
