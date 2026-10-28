import { parseBuildActivity, type BuildActivity, MAX_ACTIVITY_EVENTS } from "./build-activity"
// COMPONENT: Build state transitions
// PURPOSE: Keep live events and persisted history consistent without losing errors.
// INPUTS: Validated event frames or a persisted build snapshot.
// OUTPUTS: Workspace build state.
// STEPS: Validate event fields, preserve files, replace canonical terminal logs.
// EDGE CASES: Failed history includes errors; pending history is not a live stream.
// ERROR STATES: Malformed events throw before React state updates are scheduled.

import {
  isGeneratedFiles,
  type BuildEvent,
  type GeneratedFiles,
} from './build-events'

export type FileTree = GeneratedFiles
export type BuildPhase =
  | { name: 'idle' }
  | {
      name: 'pending' | 'generating' | 'building' | 'retrying' | 'deploying'
      message: string
      attempt: number
    }
  | { name: 'success'; attempt: number; buildLog: string; deployedUrl?: string }
  | { name: 'failed'; attempt: number; error: string; outcomeUnknown?: boolean }

export interface BuildStreamState {
  buildId?: string
  activity?: BuildActivity[]
  phase: BuildPhase
  files: FileTree | null
  logs: string[]
  connection?: 'connecting' | 'connected' | 'reconnecting'
  streamed: boolean
}

export interface PersistedBuildState {
  id?: string
  errorMessage?: string | null
  status: string
  buildLog: string | null
  deployedUrl: string | null
  files: FileTree | null
  attemptCount: number
}

export const INITIAL_BUILD_STATE: BuildStreamState = {
  phase: { name: 'idle' },
  files: null,
  logs: [],
  streamed: false,
}

/** Restores failed artifacts as well as successful ones when selecting history. */
export function hydrateBuildState(
  build: PersistedBuildState,
): BuildStreamState {
  const phase: BuildPhase =
    build.status === 'success'
      ? {
          name: 'success',
          attempt: build.attemptCount,
          buildLog: build.buildLog ?? '',
          deployedUrl: build.deployedUrl ?? undefined,
        }
      : build.status === 'failed'
        ? {
            name: 'failed',
            attempt: build.attemptCount,
            error: build.errorMessage ?? 'Build failed',
          }
        : build.status === 'pending' || build.status === 'generating' || build.status === 'building'
          ? { name: build.status, message: build.status === 'pending' ? 'Build queued.' : 'Restoring build progress…', attempt: build.attemptCount }
          : { name: 'idle' }
  return {
    buildId: build.id,
    phase,
    files: build.files,
    logs: build.buildLog?.split('\n').filter(Boolean) ?? [],
    streamed: false,
  }
}

/** Applies one SSE event; complete logs replace streamed copies rather than duplicating them. */
export function reduceBuildEvent(
  previous: BuildStreamState,
  event: BuildEvent,
): BuildStreamState {
  const { type, data } = event
  const state =
    typeof data.buildId === 'string'
      ? { ...previous, buildId: data.buildId }
      : previous
  const attempt = typeof data.attempt === 'number' ? data.attempt : 0
  if (type === 'activity_v1') {
    if (previous.buildId && typeof data.buildId === 'string' && data.buildId !== previous.buildId) return previous
    const sequence = Number(event.id)
    const [activity] = parseBuildActivity([{sequence, attempt, operation: data.operation, state: data.state, occurredAt: data.occurredAt}])
    if (!activity || (previous.activity?.at(-1)?.sequence ?? 0) >= sequence) return state
    return {...state, activity: [...(previous.activity ?? []), activity].slice(-MAX_ACTIVITY_EVENTS)}
  }
  if (type === 'status') {
    const name = data.phase === 'queued' ? 'pending' : data.phase
    if (
      name !== 'pending' &&
      name !== 'generating' &&
      name !== 'building' &&
      name !== 'retrying' &&
      name !== 'deploying'
    )
      throw new Error('Invalid build phase.')
    if (typeof data.message !== 'string')
      throw new Error('Invalid build progress message.')
    return { ...state, phase: { name, message: data.message, attempt } }
  }
  if (type === 'file_tree') {
    if (!isGeneratedFiles(data.files))
      throw new Error('Invalid generated files.')
    return { ...state, files: data.files }
  }
  if (type === 'log_line') {
    if (typeof data.line !== 'string') throw new Error('Invalid build log.')
    return { ...state, logs: [...state.logs, data.line] }
  }
  if (type === 'complete') {
    if (typeof data.success !== 'boolean')
      throw new Error('Invalid build result.')
    const phase: BuildPhase = data.success
      ? {
          name: 'success',
          attempt,
          buildLog: typeof data.buildLog === 'string' ? data.buildLog : '',
          deployedUrl:
            typeof data.deployedUrl === 'string' ? data.deployedUrl : undefined,
        }
      : {
          name: 'failed',
          attempt,
          error: typeof data.error === 'string' ? data.error : 'Build failed',
        }
    return {
      ...state,
      phase,
      logs:
        typeof data.buildLog === 'string'
          ? data.buildLog.split('\n').filter(Boolean)
          : state.logs,
    }
  }
  return state
}
