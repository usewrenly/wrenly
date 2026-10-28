/**
 * Plaintext project-draft contracts.
 * Drafts are ideas, not executable source or build records.
 * Strict bounded content/sharing/archive inputs carry revision and request identities for explicit saved actions.
 */
import { z } from "zod";
const Uuid = z.string().uuid();
const Title = z.string().trim().min(1).max(100);
const Body = z.string().max(50_000);
const Member = z
  .object({
    userId: z.string().min(1).max(128),
    role: z.enum(["viewer", "editor"]),
  })
  .strict();
export const DraftCreate = z
  .object({ requestId: Uuid, draftId: Uuid, title: Title, body: Body })
  .strict();
export const DraftChange = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("content"),
      requestId: Uuid,
      expectedRevision: Uuid,
      title: Title,
      body: Body,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sharing"),
      requestId: Uuid,
      expectedRevision: Uuid,
      mode: z.enum(["private", "selected", "instance"]),
      instanceRole: z.enum(["viewer", "editor"]),
      members: z
        .array(Member)
        .max(100)
        .refine(
          (rows) => new Set(rows.map((row) => row.userId)).size === rows.length,
          "Choose each member once.",
        ),
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
export class DraftError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
    this.name = "DraftError";
  }
}
