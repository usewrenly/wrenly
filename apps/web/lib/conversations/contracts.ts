// Validates saved conversation data before it becomes browser state.
import { BuildDatabaseSelection } from "@wrenly/db/app-database-build-contract";
import { isSkillUsage, type SkillUsed } from "../skills/contracts";

// Match the API history page and prompt limits without accepting unbounded stored input.
const MAX_HISTORY_PAGE_ITEMS = 100
const MAX_MESSAGE_CHARACTERS = 16_000

export type ConversationMode = 'auto' | 'ask' | 'build' | 'plan'
export type TurnStatus = 'queued' | 'running' | 'waiting_build' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
export interface ConversationRequest {
  database?: BuildDatabaseSelection
  message: string
  mode: ConversationMode
  baseBuildId: string | null
  model?: string
  provider?: string
}
export interface ProjectAuthor {
  id: string
  name: string
  pictureUrl: string | null
}
export interface ConversationMessage {
  author?: ProjectAuthor | null
  actorId?: string | null
  id: string
  turnId: string
  sequence: number
  role: 'user' | 'assistant'
  content: string
  kind: string
  createdAt: string
}
export interface ConversationTurn {
  database?: BuildDatabaseSelection
  skillsUsed?: SkillUsed[]
  actorId?: string
  id: string
  status: TurnStatus
  mode: ConversationMode
  baseBuildId: string | null
  buildId: string | null
  errorMessage: string | null
  model: string
  provider: string
}
export interface ConversationHistory {
  conversationId: string | null
  messages: ConversationMessage[]
  turns: ConversationTurn[]
  latestTurn: ConversationTurn | null
  nextCursor: number | null
}
export type ConversationFetch = (path: `/api/${string}`, init?: RequestInit) => Promise<Response>
const TURN_STATUSES = new Set(['queued', 'running', 'waiting_build', 'completed', 'failed', 'interrupted', 'cancelled'])
export const ACTIVE_TURN_STATUSES = new Set<TurnStatus>(['queued', 'running', 'waiting_build'])

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}
function isTurn(value: unknown): value is ConversationTurn {
  return object(value)
    && (value.database === undefined || BuildDatabaseSelection.safeParse(value.database).success)
    && (value.skillsUsed === undefined || isSkillUsage(value.skillsUsed))
    && (value.actorId === undefined || typeof value.actorId === 'string')
    && typeof value.id === 'string'
    && TURN_STATUSES.has(String(value.status))
    && ['auto', 'ask', 'build', 'plan'].includes(String(value.mode))
    && nullableString(value.baseBuildId)
    && nullableString(value.buildId)
    && nullableString(value.errorMessage)
    && typeof value.model === 'string'
    && typeof value.provider === 'string'
}
function isMessage(value: unknown): value is ConversationMessage {
  return object(value)
    && typeof value.id === 'string'
    && typeof value.turnId === 'string'
    && (value.actorId === undefined || nullableString(value.actorId))
    && Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0
    && ['user', 'assistant'].includes(String(value.role))
    && (value.author === undefined || value.author === null
      || object(value.author) && typeof value.author.id === 'string'
        && typeof value.author.name === 'string' && nullableString(value.author.pictureUrl))
    && typeof value.content === 'string'
    && typeof value.kind === 'string'
    && typeof value.createdAt === 'string'
}

/** Rejects malformed history before messages or action identities enter React state. */
export function parseConversationHistory(value: unknown): ConversationHistory {
  if (!object(value) || !nullableString(value.conversationId)
    || !Array.isArray(value.messages) || value.messages.length > MAX_HISTORY_PAGE_ITEMS
    || !value.messages.every(isMessage)
    || !Array.isArray(value.turns) || value.turns.length > MAX_HISTORY_PAGE_ITEMS
    || !value.turns.every(isTurn)
    || (value.latestTurn !== null && !isTurn(value.latestTurn))
    || (value.nextCursor !== null
      && (!Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < 1))) {
    throw new Error('The API returned invalid conversation history.')
  }
  return value as unknown as ConversationHistory
}
/** Checks a saved dashboard/recovery request without accepting arbitrary action fields. */
export function parseConversationRequest(value: unknown): ConversationRequest {
  if (!object(value) || typeof value.message !== 'string' || !value.message.trim() || value.message.length > MAX_MESSAGE_CHARACTERS ||
    !['auto', 'ask', 'build', 'plan'].includes(String(value.mode)) || !nullableString(value.baseBuildId) ||
    (value.database !== undefined && !BuildDatabaseSelection.safeParse(value.database).success) ||
    (value.model !== undefined && typeof value.model !== 'string') || (value.provider !== undefined && typeof value.provider !== 'string'))
    throw new Error('The saved message could not be restored. Review it before sending again.')
  return { ...(value.database !== undefined ? { database: BuildDatabaseSelection.parse(value.database) } : {}), message: value.message, mode: value.mode as ConversationMode, baseBuildId: value.baseBuildId,
    ...(typeof value.model === 'string' ? { model: value.model } : {}), ...(typeof value.provider === 'string' ? { provider: value.provider } : {}) }
}
