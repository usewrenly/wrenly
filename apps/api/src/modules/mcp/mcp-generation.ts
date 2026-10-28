import { parseSkillGuidance } from "@wrenly/inference"
// COMPONENT: Bounded MCP generation call
// PURPOSE: Apply one deadline to initialization/tool execution and reap the server on abort.
// INPUTS: Server command, allowlisted environment, generation input, optional abort signal.
// OUTPUTS: Structured files, or an operation/cleanup error.
// STEPS: Connect, call tool with signal, parse, close once, confirm process exit.
// EDGE CASES: Abort before spawn starts no process; timeout covers initialization too.
// ERROR STATES: Unconfirmed subprocess cleanup is explicit and cannot be treated as a model repair.
import { applyFileEdits, validateEditContext } from './file-edits'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { z } from 'zod'
import type { AgentInput, AgentOutput } from './agent-client'

const SkillCapabilitySchema = z.object({type:z.literal('object'),properties:z.object({version:z.object({const:z.literal(1)})})})
const MAX_MCP_RESULT_BYTES = 2 * 1024 * 1024
const GENERATION_TIMEOUT_MS = 180_000
const PROCESS_EXIT_GRACE_MS = 5000
const PROCESS_EXIT_POLL_MS = 25
const EDIT_ERRORS = {
  invalid_edit_json: 'The model returned invalid JSON for the edit. Return one complete JSON object with numeric version 1 and explicit operations, without Markdown.',
  edit_response_truncated: 'The model reached its output limit before completing the edit. Return fewer changed files with complete contents, or select a model with a larger output budget.',
  edit_response_unfinished: 'The model did not finish a usable edit response. Retry explicitly or select another model.',
  invalid_edit_input: 'The editing MCP server rejected the complete revision or editing inputs.',
  invalid_edit_output: 'The model returned a structurally invalid file-edit response. Return version 1 with explicit file operations.',
  edit_model_error: 'The editing model request failed. Check the configured provider and selected model.',
} as const
const EditErrorSchema = z.object({ error: z.object({ code: z.enum(['invalid_edit_input', 'invalid_edit_output', 'edit_model_error', 'invalid_edit_json', 'edit_response_truncated', 'edit_response_unfinished']) }) })
const OutputSchema = z.object({ files: z.array(z.object({ path: z.string().min(1), content: z.string() })).min(1) })

export class McpCleanupError extends Error {
  constructor() { super('MCP server process cleanup could not be confirmed.'); this.name = 'McpCleanupError' }
}

class OwnedStdioTransport extends StdioClientTransport {
  spawnedPid: number | null = null
  override async start(): Promise<void> {
    try { await super.start() }
    finally { this.spawnedPid = this.pid }
  }
}

export interface McpGenerationServer { command: string; args: string[]; env: Record<string, string> }

async function confirmProcessExit(pid: number | null): Promise<void> {
  if (pid === null) return
  try {
    const deadline = Date.now() + PROCESS_EXIT_GRACE_MS
    while (Date.now() < deadline) {
      try { process.kill(pid, 0) }
      catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return
        throw new McpCleanupError()
      }
      await new Promise((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS))
    }
    throw new McpCleanupError()
  } catch { throw new McpCleanupError() }
}

/** Calls an MCP generation tool with a whole-operation deadline and confirmed subprocess cleanup. */
export async function generateWithMcp(
  server: McpGenerationServer, input: AgentInput, signal?: AbortSignal,
  timeoutMs: number = GENERATION_TIMEOUT_MS,
): Promise<AgentOutput> {
  const guidance = parseSkillGuidance(input.skills_v1)
  const editing = Boolean(input.previousFiles?.length)
  if (editing) validateEditContext(input.previousFiles!)
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid MCP generation deadline.')
  if (signal?.aborted) throw signal.reason ?? new Error('Generation aborted.')
  const controller = new AbortController()
  const client = new Client({ name: 'wrenly-orchestrator', version: '0.0.1' }, { capabilities: {} })
  const transport = new OwnedStdioTransport(server)
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (!closing) {
      const pid = transport.spawnedPid ?? transport.pid
      closing = (async (): Promise<void> => {
        try {
          try { await client.close() }
          finally { await transport.close(); await confirmProcessExit(pid) }
        } catch { throw new McpCleanupError() }
      })()
    }
    return closing
  }
  const onAbort = (): void => {
    controller.abort(signal?.reason ?? new Error('Generation aborted.'))
    void close().catch(() => {})
  }
  const timer = setTimeout(() => {
    controller.abort(new Error('MCP generation deadline exceeded.'))
    void close().catch(() => {})
  }, timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (signal?.aborted) onAbort()
    controller.signal.throwIfAborted()
    await client.connect(transport, { signal: controller.signal, timeout: timeoutMs })
    controller.signal.throwIfAborted()
    if (editing || guidance.skills.length) {
      const tools = await client.listTools({}, { signal: controller.signal, timeout: timeoutMs })
      if (guidance.skills.length && !tools.tools.some(tool => tool.name === (editing ? 'edit_app_v1' : 'generate_app') && tool.inputSchema.properties && SkillCapabilitySchema.safeParse(tool.inputSchema.properties.skills_v1).success))
        throw new Error('This MCP server does not support versioned project skills. No guidance was dropped.')
      if (editing && !tools.tools.some(tool => tool.name === 'edit_app_v1'))
        throw new Error('This MCP server does not support revision-safe editing (edit_app_v1).')
    }
    const result = await client.callTool({ name: editing ? 'edit_app_v1' : 'generate_app', arguments: {
      ...(guidance.skills.length ? { skills_v1: guidance } : {}),
      prompt: input.prompt, previousErrors: input.previousErrors, attempt: input.attempt,
      ...(editing ? { version: 1, files: input.previousFiles } : {}),
    } }, undefined, { signal: controller.signal, timeout: timeoutMs })
    controller.signal.throwIfAborted()
    const response = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(result)
    if (response.isError) {
      const structured = EditErrorSchema.safeParse(response.structuredContent)
      throw new Error(editing && structured.success ? EDIT_ERRORS[structured.data.error.code] : 'MCP generation tool reported an error.')
    }
    const text = response.content.find((entry) => entry.type === 'text')
    if (!text || typeof text.text !== 'string') throw new Error('MCP server returned no generated source.')
    if (Buffer.byteLength(text.text) > MAX_MCP_RESULT_BYTES) throw new Error('MCP source response exceeds the artifact limits.')
    const output: unknown = JSON.parse(text.text)
    return editing ? { files: applyFileEdits(input.previousFiles!, output) } : OutputSchema.parse(output)
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    // Preserve parse/contract diagnostics for the repair loop; callers log no query/source payloads.
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    await close()
  }
}
