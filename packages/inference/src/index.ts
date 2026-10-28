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
