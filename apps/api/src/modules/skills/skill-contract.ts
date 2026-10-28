// Client writes exclude server-owned authority, versions and content hashes.
import { z } from "zod";
export const MAX_LIBRARY_SKILLS = 100;
const Uuid = z.string().uuid();
const Provenance = {
  document: z.string().max(16 * 1024),
  source: z.enum(["authored", "imported"]),
  sourceUrl: z
    .url()
    .max(2048)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "Record an HTTPS source URL without credentials, query or fragment.")
    .nullable(),
  versionLabel: z.string().trim().min(1).max(64).nullable(),
  licenseNotes: z.string().max(2000),
};
export const SkillCreate = z
  .object({ requestId: Uuid, skillId: Uuid, ...Provenance })
  .strict();
export const SkillChange = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("content"),
      requestId: Uuid,
      expectedRevision: Uuid,
      ...Provenance,
    })
    .strict(),
  z
    .object({
      kind: z.literal("archive"),
      requestId: Uuid,
      expectedRevision: Uuid,
      archived: z.boolean(),
    })
    .strict(),
]);
export type SkillProvenance = Pick<
  z.infer<typeof SkillCreate>,
  "source" | "sourceUrl" | "versionLabel" | "licenseNotes"
>;
export class SkillError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "SkillError";
  }
}
