import { parseSkillGuidance, type SkillGuidance } from "../guidance/skill-guidance"
// Shared model file-edit contract for every supported framework MCP server.
// INPUTS: Unknown tool arguments or model completion data.
// OUTPUTS: Validated version-1 revision/operations, or a safe categorized failure.
// STEPS: Check shape, paths and budgets; reject unfinished completions; parse operations.
// Complete source is never truncated. The API separately checks operation existence
// and merges against its saved revision; these helpers grant no execution authority.
export interface EditInput {
  skills_v1?: SkillGuidance
  version: 1
  prompt: string
  files: Array<{ path: string; content: string }>
  previousErrors: string[]
  attempt: number
}
export type FileOperation = { type: 'create' | 'update'; path: string; content: string } | { type: 'delete'; path: string }
export interface EditOutput { version: 1; operations: FileOperation[] }
export type EditErrorCode = 'invalid_edit_input' | 'invalid_edit_output' | 'edit_model_error' | 'invalid_edit_json' | 'edit_response_truncated' | 'edit_response_unfinished'
export class EditContractError extends Error {
  constructor(public readonly code: EditErrorCode, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'EditContractError'
  }
}
const MAX_CONTEXT_BYTES = 128_000
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 1000
const MAX_PROMPT_CHARS = 16_000

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\\:]/.test(value) && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')
}

/** Validates MCP input locally; the orchestrator independently validates the resulting merge. */
export function parseEditInput(value: unknown): EditInput {
  if (!record(value) || value.version !== 1 || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT_CHARS ||
    !Number.isInteger(value.attempt) || Number(value.attempt) < 1 || Number(value.attempt) > 3 ||
    !Array.isArray(value.previousErrors) || value.previousErrors.length > 3 || !value.previousErrors.every(error => typeof error === 'string' && error.length <= MAX_PROMPT_CHARS) ||
    !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES ||
    !value.files.every(file => record(file) && safePath(file.path) && typeof file.content === 'string'))
    throw new EditContractError('invalid_edit_input', 'edit_app_v1 requires version 1, complete source files, prompt, attempt and bounded prior errors.')
  if (Object.keys(value).some(key => !['version', 'prompt', 'files', 'previousErrors', 'attempt', 'skills_v1'].includes(key)))
    throw new EditContractError('invalid_edit_input', 'edit_app_v1 contains unsupported input fields.')
  const files = value.files.map(file => ({ path: String(file.path), content: String(file.content) }))
  const paths = new Set(files.map(file => file.path))
  if (paths.size !== files.length || files.some(file => file.path.split('/').slice(0, -1).some((_, index, parts) => paths.has(parts.slice(0, index + 1).join('/')))))
    throw new EditContractError('invalid_edit_input', 'edit_app_v1 requires unambiguous source paths.')
  if (Buffer.byteLength(JSON.stringify(files)) + Buffer.byteLength(JSON.stringify(parseSkillGuidance(value.skills_v1))) > MAX_CONTEXT_BYTES)
    throw new EditContractError('invalid_edit_input', 'Complete revision exceeds the editing context budget. No files were truncated.')
  return { ...(value.skills_v1 === undefined ? {} : { skills_v1: parseSkillGuidance(value.skills_v1) }), version: 1, prompt: value.prompt, files, previousErrors: value.previousErrors as string[], attempt: Number(value.attempt) }
}

/** Parses only the versioned operations contract, never interpreting generated commands. */
export function parseEditOutput(content: string): EditOutput {
  if (Buffer.byteLength(content) > MAX_RESPONSE_BYTES) throw new EditContractError('invalid_edit_output', 'Edit output exceeds the supported artifact budget.')
  let value: unknown
  // Some compatible providers wrap even JSON-mode answers. Remove only a whole
  // enclosing fence; never extract fragments from prose or reconstruct broken JSON.
  const trimmed = content.trim()
  const enclosed = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/)
  try { value = JSON.parse(enclosed?.[1] ?? trimmed) }
  catch { throw new EditContractError('invalid_edit_json', 'Edit response must be valid JSON containing version 1 and file operations.') }
  if (!record(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'operations'].includes(key)) ||
    !Array.isArray(value.operations) || value.operations.length > MAX_FILES)
    throw new EditContractError('invalid_edit_output', 'Invalid versioned edit response.')
  const operations: FileOperation[] = []
  const seen = new Set<string>()
  for (const operation of value.operations) {
    if (!record(operation) || !safePath(operation.path) || !['create', 'update', 'delete'].includes(String(operation.type)) ||
      Object.keys(operation).some(key => !(operation.type === 'delete' ? ['type', 'path'] : ['type', 'path', 'content']).includes(key)) ||
      (operation.type !== 'delete' && typeof operation.content !== 'string') || seen.has(operation.path))
      throw new EditContractError('invalid_edit_output', 'Invalid or conflicting file edit operation.')
    seen.add(operation.path)
    if (operation.type === 'delete') operations.push({ type: 'delete', path: operation.path })
    else operations.push({ type: operation.type as 'create' | 'update', path: operation.path, content: String(operation.content) })
  }
  return { version: 1, operations }
}

/** Categorizes completion failures without exposing model content or provider metadata. */
export function parseEditCompletion(choice: unknown): EditOutput {
  if (record(choice) && choice.finish_reason === 'length')
    throw new EditContractError('edit_response_truncated', 'The model reached its output limit before completing the edit.')
  if (!record(choice) || choice.finish_reason !== 'stop' || !record(choice.message) ||
    choice.message.refusal || typeof choice.message.content !== 'string' || !choice.message.content.trim())
    throw new EditContractError('edit_response_unfinished', 'The model did not return a finished edit response.')
  return parseEditOutput(choice.message.content)
}
