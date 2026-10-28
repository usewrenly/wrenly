/** Private runtime identities and effect receipts; these contain no credentials and are not public HTTP DTOs. */
import { z } from "zod";
/** Each resource owns distinct role names; callers must close that role's clients before termination. */
export type AppDatabaseSessionTarget = "reader" | "migrator" | "runtime";
const UUID = z.string().uuid();
const DockerId = z.string().regex(/^[a-f0-9]{64}$/);
const Image = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const AppDatabaseRuntimeIdentity = z
  .object({
    version: z.literal(1),
    containerId: DockerId,
    networkId: DockerId,
    volumeName: z.string().min(1).max(128),
    imageId: Image,
  })
  .strict();
export type AppDatabaseRuntimeIdentity = z.infer<
  typeof AppDatabaseRuntimeIdentity
>;
export const AppDatabaseSocketIdentity = z
  .object({
    id: UUID,
    resourceId: UUID,
    projectId: UUID,
    containerId: DockerId,
    volumeName: z.string().min(1).max(128),
    imageId: Image,
  })
  .strict();
export type AppDatabaseSocketIdentity = z.infer<
  typeof AppDatabaseSocketIdentity
>;
export const PreviewDatabaseEffectKind = z.enum([
  "prepare-artifact",
  "create-socket",
  "start-application",
]);
export type PreviewDatabaseEffectKind = z.infer<
  typeof PreviewDatabaseEffectKind
>;
export const PreviewDatabaseCleanupKind = z.enum([
  "application",
  "socket",
  "sessions",
  "artifact",
]);
export type PreviewDatabaseCleanupKind = z.infer<
  typeof PreviewDatabaseCleanupKind
>;
export interface PreviewDatabaseEffect {
  kind: PreviewDatabaseEffectKind;
  id: string;
  startedAt: string;
}
export interface PreviewDatabaseCleanupEffect {
  kind: PreviewDatabaseCleanupKind;
  id: string;
  startedAt: string;
}
