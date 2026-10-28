import { SKILL_GUIDANCE_SCHEMA } from "@wrenly/inference"
// Offers generation and revision-editing tools over MCP input/output pipes.
// The API owns this process; closing parent input must stop outstanding model work.
// Model requests live in index.ts. Generated applications run only in the sandbox.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { generateApp, editApp } from './index'
import { EditContractError } from '@wrenly/inference'

// ─── MCP Server definition ────────────────────────────────────────────────────

const server = new Server(
  {
    name: 'wrenly-laravel-agent',
    version: '0.0.1',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// ─── Tool: list ───────────────────────────────────────────────────────────────
// The orchestrator calls this first to discover what the agent can do.

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'edit_app_v1',
      description: 'Apply explicit create/update/delete operations to a complete frozen Laravel revision. Omitted files remain unchanged.',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['version', 'prompt', 'files', 'previousErrors', 'attempt'],
        properties: {
          skills_v1: SKILL_GUIDANCE_SCHEMA, version: { type: 'integer', const: 1 }, prompt: { type: 'string', minLength: 1, maxLength: 16000 },
          files: { type: 'array', minItems: 1, maxItems: 1000, items: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } },
          previousErrors: { type: 'array', maxItems: 3, items: { type: 'string' } },
          attempt: { type: 'integer', minimum: 1, maximum: 3 },
        },
      },
    },
    {
      name: 'generate_app',
      description:
        'Generate a complete Laravel 13 application from a natural language prompt. ' +
        'Returns a FileTree: an array of { path, content } objects ready for sandbox execution.',
      inputSchema: {
        type: 'object',
        required: ['prompt', 'previousErrors', 'attempt'],
        properties: {
          skills_v1: SKILL_GUIDANCE_SCHEMA,
          prompt: {
            type: 'string',
            description: 'What the user wants to build',
          },
          previousErrors: {
            type: 'array',
            items: { type: 'string' },
            description: 'Build errors from previous sandbox attempts (empty on first attempt)',
          },
          attempt: {
            type: 'number',
            description: 'Attempt number: 1, 2, or 3',
          },
        },
      },
    },
  ],
}))

// ─── Tool: call ───────────────────────────────────────────────────────────────
// The orchestrator calls this to actually run the generation.

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'edit_app_v1') {
    try {
      const result = await editApp(request.params.arguments)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } catch (error) {
      return { isError: true, structuredContent: { error: { code: error instanceof EditContractError ? error.code : 'edit_model_error' } },
        content: [{ type: 'text', text: 'Laravel editing failed. Validate the complete revision and model configuration.' }] }
    }
  }
  if (request.params.name !== 'generate_app') {
    throw new Error(`Unknown tool: ${request.params.name}`)
  }

  try {
    // Treat tool arguments as untrusted even when the caller is our own API.
    const result = await generateApp(request.params.arguments)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch {
    // Provider bodies and generated source must never become protocol diagnostics.
    return { isError: true, content: [{ type: 'text', text: 'Laravel generation failed. Check the selected model and complete source response.' }] }
  }
})

// ─── Start ────────────────────────────────────────────────────────────────────
// Connect via stdio — the orchestrator communicates through stdin/stdout pipes.

// The API owns this stdio server. A crashed parent must not leave inference running.
process.stdin.once('end', () => process.exit(0))

const transport = new StdioServerTransport()

void (async () => {
  await server.connect(transport)
})()