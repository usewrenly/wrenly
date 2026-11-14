/** Bounded versioned MCP payload; inline canonical bytes never grant file or network access. */
import { buildAttachmentMessage, type ModelAttachment } from "./model-content";
import { ATTACHMENT_LIMITS, AttachmentPolicyError } from "./policy";
export interface AttachmentWireContent {
  version: 1;
  files: Array<{
    mediaType: ModelAttachment["mediaType"];
    sha256: string;
    dataBase64: string;
  }>;
}
// Leave space under the SDK's 10 MiB stdio buffer for source, skills and JSON framing.
export const MAX_ATTACHMENT_WIRE_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_TOOL_REQUEST_BYTES = 9 * 1024 * 1024;
export const ATTACHMENT_WIRE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["version", "files"],
  properties: {
    version: { type: "integer", const: 1 },
    files: {
      type: "array",
      maxItems: ATTACHMENT_LIMITS.count,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mediaType", "sha256", "dataBase64"],
        properties: {
          mediaType: {
            type: "string",
            enum: ["image/webp", "text/plain", "text/markdown"],
          },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          dataBase64: {
            type: "string",
            minLength: 4,
            maxLength: Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4,
          },
        },
      },
    },
  },
} as const;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** Parses and verifies the content independently at each side of the MCP connection. */
export function parseAttachmentWireContent(value: unknown): ModelAttachment[] {
  if (value === undefined) return [];
  if (
    !record(value) ||
    value.version !== 1 ||
    Object.keys(value).some((key) => !["version", "files"].includes(key)) ||
    !Array.isArray(value.files) ||
    value.files.length > ATTACHMENT_LIMITS.count
  )
    throw new AttachmentPolicyError("Unsupported attachment content contract.");
  const result: ModelAttachment[] = [];
  let wireBytes = 0;
  for (const file of value.files) {
    if (
      !record(file) ||
      Object.keys(file).length !== 3 ||
      Object.keys(file).some(
        (key) => !["mediaType", "sha256", "dataBase64"].includes(key),
      ) ||
      !["image/webp", "text/plain", "text/markdown"].includes(
        String(file.mediaType),
      ) ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      typeof file.dataBase64 !== "string" ||
      !file.dataBase64.length ||
      file.dataBase64.length > Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4
    )
      throw new AttachmentPolicyError("Invalid attachment content.");
    wireBytes += file.dataBase64.length;
    if (wireBytes > MAX_ATTACHMENT_WIRE_BYTES)
      throw new AttachmentPolicyError(
        "Reference files are too large for this model request. Use fewer or smaller files.",
      );
    const bytes = Buffer.from(file.dataBase64, "base64");
    if (bytes.toString("base64") !== file.dataBase64)
      throw new AttachmentPolicyError("Invalid attachment encoding.");
    result.push({
      bytes,
      sha256: file.sha256,
      mediaType: file.mediaType as ModelAttachment["mediaType"],
    });
  }
  buildAttachmentMessage("", result, true);
  return result;
}
/** Converts already resolved content to the same verified versioned format used by framework tools. */
export function encodeAttachmentWireContent(
  files: readonly ModelAttachment[],
): AttachmentWireContent {
  const payload: AttachmentWireContent = {
    version: 1,
    files: files.map((file) => ({
      mediaType: file.mediaType,
      sha256: file.sha256,
      dataBase64: Buffer.from(file.bytes).toString("base64"),
    })),
  };
  parseAttachmentWireContent(payload);
  return payload;
}

/** Keeps historical text-only prompts unchanged and supplies real image parts when references exist. */
export function attachmentPromptContent(
  prompt: string,
  value: unknown,
): string | import("./model-content").AttachmentMessagePart[] {
  const files = parseAttachmentWireContent(value);
  return files.length ? buildAttachmentMessage(prompt, files, true) : prompt;
}
