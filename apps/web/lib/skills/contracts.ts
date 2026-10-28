// Validates browser-visible Skill versions without importing server inference or YAML code.
import { z } from "zod";
const Uuid = z.string().uuid();
export const SkillVersionSchema = z.object({
  id: Uuid,
  skillId: Uuid,
  document: z.string(),
  sha256: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["authored", "imported"]),
  sourceUrl: z.string().nullable(),
  versionLabel: z.string().nullable(),
  licenseNotes: z.string(),
  createdAt: z.string(),
});
const Head = z.object({
  id: Uuid,
  revision: Uuid,
  currentVersionId: Uuid,
  archivedAt: z.string().nullable(),
});
export const LibrarySchema = z.object({
  skills: z
    .array(z.object({ skill: Head, version: SkillVersionSchema }))
    .max(100),
});
export const HistorySchema = z.object({
  skill: Head,
  versions: z.array(SkillVersionSchema).max(50),
  historyLimit: z.number(),
});
export const SaveSchema = z.object({
  skillId: Uuid,
  savedRevision: Uuid,
  currentRevision: Uuid,
  versionId: Uuid,
  replayed: z.boolean(),
});
export const ProjectSkillSchema = z.object({
  revision: Uuid,
  canManage: z.boolean(),
  savedRevision: Uuid.optional(),
  replayed: z.boolean().optional(),
  selected: z
    .array(
      z.object({
        skillId: Uuid,
        versionId: Uuid,
        name: z.string(),
        description: z.string(),
        document: z.string(),
        sha256: z.string(),
        source: z.enum(["authored", "imported"]),
        sourceUrl: z.string().nullable(),
        versionLabel: z.string().nullable(),
        licenseNotes: z.string(),
        archived: z.boolean(),
      }),
    )
    .max(4),
});
export type SkillVersion = z.infer<typeof SkillVersionSchema>;
export type SkillLibrary = z.infer<typeof LibrarySchema>;
export type ProjectSkillState = z.infer<typeof ProjectSkillSchema>;
export type SkillProvenance = Pick<
  SkillVersion,
  "document" | "source" | "sourceUrl" | "versionLabel" | "licenseNotes"
>;
export type SkillPending = {
  path: `/api/${string}`;
  method: "POST" | "PATCH";
  body: Record<string, unknown>;
  skillId: string;
  requestId: string;
};
// Admission permits at most four pinned instructions in a request snapshot.
const MAX_SKILLS_USED = 4;

export interface SkillUsed {
  name: string;
  versionId: string;
  sha256: string;
}
/** Checks public version attribution before conversation history renders it. */
export function isSkillUsage(value: unknown): value is SkillUsed[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_SKILLS_USED &&
    value.every(
      (item: unknown) =>
        typeof item === "object" &&
        item !== null &&
        "name" in item &&
        typeof item.name === "string" &&
        "versionId" in item &&
        typeof item.versionId === "string" &&
        "sha256" in item &&
        typeof item.sha256 === "string",
    )
  );
}
