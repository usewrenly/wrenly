/**
 * Inference means asking an AI model for an answer: an explanation, plan or code.
 * Exports the shared connection rules and saved instruction types used by the API
 * and framework MCP servers. Importing this module sends no model request.
 */
export {
  resolveProviderDestination,
  isAllowedProviderAddress,
  ProviderDestinationError,
  type ProviderLookup,
} from "./network/destination";
export {
  createInferenceFetch,
  InferenceTransportError,
} from "./network/transport";
export {
  parseSkillGuidance,
  skillGuidanceMessage,
  SKILL_AUTHORITY,
  SKILL_GUIDANCE_SCHEMA,
  type FrozenSkill,
  type SkillGuidance,
} from "./guidance/skill-guidance";

export {
  parseEditInput,
  parseEditOutput,
  parseEditCompletion,
  EditContractError,
  type EditInput,
  type EditOutput,
  type FileOperation,
  type EditErrorCode,
} from "./contracts/edit-contract";

export {
  ATTACHMENT_LIMITS,
  AttachmentPolicyError,
  validateAttachmentBatch,
  decodeAttachmentText,
  detectAttachmentImage,
  type AttachmentMediaType,
} from "./attachments/policy";
export {
  parseAttachmentSnapshot,
  type AttachmentSnapshot,
  type AttachmentReference,
} from "./attachments/references";
export {
  buildAttachmentMessage,
  type ModelAttachment,
  type AttachmentMessagePart,
} from "./attachments/model-content";
export {
  parseAttachmentWireContent,
  encodeAttachmentWireContent,
  ATTACHMENT_WIRE_SCHEMA,
  MAX_ATTACHMENT_TOOL_REQUEST_BYTES,
  type AttachmentWireContent,
} from "./attachments/wire-content";
export { attachmentPromptContent } from "./attachments/wire-content";
