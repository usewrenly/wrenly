import type { SkillGuidance } from "@wrenly/inference"
// Starts the selected framework MCP server for one build attempt. MCP is the
// tool-call protocol; the chosen model supplies the answer through that server.
// Saved credentials enter an allowlisted environment, never tool arguments.
// Existing *-agent names are package compatibility identifiers, not autonomous agents.

import { generateWithMcp } from './mcp-generation'
import { logger } from '../../lib/logger'
import path from 'path'
import { resolveExecutionProvider } from '../models/selection/saved-providers'
import { resolve } from 'node:path'
import { buildModelEnvironment } from '../models/environment/model-environment'

// ─── Types ────────────────────────────────────────────────────────────────────

export type FileTree = Array<{
    path: string
    content: string
}>

export type AgentInput = {
    skills_v1?: SkillGuidance
    /** Server-side correlation only; never sent as a generation-tool argument. */
    buildId?: string
    prompt: string
    /** Complete frozen source for edit_app_v1, never a truncated prompt block. */
    previousFiles?: FileTree
    previousErrors: string[]
    attempt: number
    /** Per-request model override passed through the MCP subprocess environment. */
    model?: string
    /** Provider id the model belongs to — resolves base URL + key server-side. */
    provider?: string
}

export type AgentOutput = {
    files: FileTree
}

type AgentConfig = {
    command: string
    args: string[]
}

// ─── Agent registry ───────────────────────────────────────────────────────────
// Maps stack names → commands to start the MCP server process.
// Bun bundles this module into apps/api/dist; source lives deeper under src/modules.
// Both entrypoints must discover the same workspace MCP server sources.

const REPO_ROOT = path.resolve(
    import.meta.dir,
    path.basename(import.meta.dir) === 'dist' ? '../../..' : '../../../../..',
)

// process.execPath = the Bun binary running this server right now.
// Avoids PATH lookup failures in the spawned child process.
const BUN_EXECUTABLE = process.execPath
// Shared default for execution and safe failure diagnostics; startup validates overrides.
const DEFAULT_MODEL_TIMEOUT_SECONDS = 180

const AGENT_REGISTRY: Record<string, AgentConfig> = {
    nextjs: {
        command: BUN_EXECUTABLE,
        args: ['--no-env-file', path.join(REPO_ROOT, 'packages/agents/nextjs-agent/src/server.ts')],
    },
    laravel: {
        command: BUN_EXECUTABLE,
        args: ['--no-env-file', path.join(REPO_ROOT, 'packages/agents/laravel-agent/src/server.ts')],
    },
    vue: {
        command: BUN_EXECUTABLE,
        args: ['--no-env-file', path.join(REPO_ROOT, 'packages/agents/vue-agent/src/server.ts')],
    },
    django: {
        // Django agent uses Python — MCP protocol is language-agnostic
        command: 'python3',
        args: [path.join(REPO_ROOT, 'packages/agents/django-agent/src/server.py')],
    },
}

// ─── callAgent ────────────────────────────────────────────────────────────────

/**
 * Resolves saved model credentials and calls the framework through MCP.
 * New source uses generate_app; existing source requires edit_app_v1.
 * Process cleanup must be confirmed before the attempt returns.
 */
export async function callAgent(
    stack: string,
    input: AgentInput,
    signal?: AbortSignal,
): Promise<AgentOutput> {
    if (input.previousFiles?.length && !['nextjs', 'laravel'].includes(stack))
        throw new Error('Revision-safe editing is not supported by this framework MCP server yet.')
    const config = AGENT_REGISTRY[stack]
    if (!config) throw new Error(`No MCP server registered for stack "${stack}".`)
    try {
        const { db } = await import('@wrenly/db')
        return await generateWithMcp({
            ...config,
            env: buildModelEnvironment(input.model, await resolveExecutionProvider(db, input.provider ?? '', resolve(process.env.WRENLY_DATA_DIR ?? '.local/wrenly')), process.env),
        }, input, signal, Number(process.env.WRENLY_MODEL_TIMEOUT_SECONDS ?? DEFAULT_MODEL_TIMEOUT_SECONDS) * 1000)
    } catch (error) {
        logger.error('MCP generation attempt failed', {
            stack, buildId: input.buildId, attempt: input.attempt,
            errorName: error instanceof Error ? error.name : 'UnknownError',
            errorCategory: signal?.aborted ? 'aborted' : error instanceof Error && error.message === 'MCP generation deadline exceeded.' ? 'generation_timeout' : 'generation_error',
            timeoutSeconds: Number(process.env.WRENLY_MODEL_TIMEOUT_SECONDS ?? DEFAULT_MODEL_TIMEOUT_SECONDS),
            protocolCode: typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined,
        })
        throw error
    }
}
