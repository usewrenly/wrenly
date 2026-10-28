/** Safe database selection saved with a build; no address, data, credential or runtime permission. */
import { z } from "zod";

export const BuildDatabaseSelection = z
  .object({
    version: z.literal(1),
    environment: z.literal("development"),
    resourceId: z.string().uuid(),
    resourceRevision: z.string().uuid(),
  })
  .strict();
export type BuildDatabaseSelection = z.infer<typeof BuildDatabaseSelection>;
