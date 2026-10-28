// Parse bounded SKILL.md instructions without I/O, package execution or inference.
import { createHash } from "node:crypto";
import { isAlias, isNode, parseDocument, visit } from "yaml";
import { z } from "zod";

export const MAX_SKILL_DOCUMENT_BYTES = 16 * 1024;
export const MAX_SELECTED_SKILLS = 4;
export const MAX_SKILL_CONTEXT_BYTES = 32 * 1024;
const MAX_FRONTMATTER_BYTES = 4 * 1024;
const frontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().trim().min(1).max(1024),
    license: z.string().trim().min(1).max(512).optional(),
    compatibility: z.string().trim().min(1).max(500).optional(),
    metadata: z
      .record(
        z
          .string()
          .min(1)
          .max(64)
          .refine(
            (key) => !["__proto__", "prototype", "constructor"].includes(key),
          ),
        z.string().max(512),
      )
      .optional(),
  })
  .strict();

export interface SkillDocument {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
  document: string;
  instructions: string;
  sha256: string;
}

export class SkillDocumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillDocumentError";
  }
}

/** Validates one instruction-only SKILL.md; YAML is inspected before alias expansion. */
export function parseSkillDocument(input: unknown): SkillDocument {
  if (
    typeof input !== "string" ||
    Buffer.byteLength(input, "utf8") > MAX_SKILL_DOCUMENT_BYTES
  )
    throw new SkillDocumentError(
      "Import one SKILL.md document of at most 16 KiB.",
    );
  if (
    input.includes("\0") ||
    Buffer.from(input, "utf8").toString("utf8") !== input
  )
    throw new SkillDocumentError(
      "Use valid UTF-8 text without null characters.",
    );
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match || Buffer.byteLength(match[1]!, "utf8") > MAX_FRONTMATTER_BYTES)
    throw new SkillDocumentError(
      "Start with YAML frontmatter between --- lines (at most 4 KiB).",
    );
  try {
    const parsed = parseDocument(match[1]!, {
      strict: true,
      uniqueKeys: true,
      logLevel: "silent",
    });
    if (parsed.errors.length || parsed.warnings.length)
      throw new SkillDocumentError(
        "Review the YAML frontmatter: duplicate keys, tags and malformed YAML are unsupported.",
      );
    visit(parsed, (_, node) => {
      if (
        isAlias(node) ||
        (isNode(node) && (node.tag || ("anchor" in node && node.anchor)))
      )
        throw new SkillDocumentError(
          "YAML anchors, aliases and explicit tags are unsupported.",
        );
    });
    const value: unknown = parsed.toJS({ maxAliasCount: 0 });
    const fields = frontmatterSchema.safeParse(value);
    if (!fields.success)
      throw new SkillDocumentError(
        "Use a lowercase hyphenated name and a description. Optional fields: license, compatibility and string metadata. Tool permissions are unsupported.",
      );
    const instructions = match[2]!.trim();
    if (!instructions)
      throw new SkillDocumentError(
        "Add the skill's Markdown instructions below its frontmatter.",
      );
    // A single-document import cannot provide files that linked instructions depend on.
    if (
      /!?\[[^\]]*\]\(\s*(?!https?:\/\/|#)([^\s)]+)[^)]*\)/i.test(instructions)
    )
      throw new SkillDocumentError(
        "Bundled scripts, references and assets are unsupported. Import self-contained instructions.",
      );
    return {
      ...fields.data,
      document: input,
      instructions,
      sha256: createHash("sha256").update(input, "utf8").digest("hex"),
    };
  } catch (error) {
    if (error instanceof SkillDocumentError) throw error;
    throw new SkillDocumentError(
      "The SKILL.md frontmatter could not be read. Review its YAML formatting.",
    );
  }
}

/** Enforces the complete selection budget without silently dropping or truncating instructions. */
export function validateSkillSelection(
  documents: readonly SkillDocument[],
): void {
  if (
    documents.length > MAX_SELECTED_SKILLS ||
    documents.reduce(
      (bytes, item) => bytes + Buffer.byteLength(item.document, "utf8"),
      0,
    ) > MAX_SKILL_CONTEXT_BYTES
  )
    throw new SkillDocumentError(
      "Select at most four skills with no more than 32 KiB of combined instructions.",
    );
}
