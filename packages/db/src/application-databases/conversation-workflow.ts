/** Private approval authority is persisted for session rechecks, never included in browser projections. */
export interface AccessPrincipal {
  userId: string;
  sessionId: string;
  revision: string;
}

import { z } from "zod";

/** Bounded public card data. Approval credentials and saved prompts stay instance-side. */
export const DatabaseWorkflowCard = z.object({
  id: z.string().uuid(),
  turnId: z.string().uuid(),
  revision: z.string().uuid(),
  state: z.enum([
    "proposed",
    "setup",
    "building",
    "waiting_build",
    "review",
    "backup",
    "migrating",
    "complete",
    "blocked",
    "declined",
    "cancelled",
  ]),
  purpose: z.string().max(2000),
  resourceId: z.string().uuid().nullable(),
  buildId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  framework: z.enum(["nextjs", "laravel"]).nullable().default(null),
  files: z
    .array(
      z.object({
        path: z.string().max(256),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        content: z.string().max(512 * 1024),
      }),
    )
    .max(129),
});
export const DatabaseWorkflowCards = z.object({
  canManage: z.boolean(),
  workflows: z.array(DatabaseWorkflowCard).max(100),
});
export type DatabaseWorkflowCards = z.infer<typeof DatabaseWorkflowCards>;
