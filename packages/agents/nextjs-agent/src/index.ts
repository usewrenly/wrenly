import { skillGuidanceMessage, SKILL_AUTHORITY, type SkillGuidance } from "@wrenly/inference"
// Turns a build request into Next.js source using the selected model connection.
// The MCP server calls these functions; returned files still require Docker validation.
// Credentials come from the API-selected environment, never a tool argument.

import OpenAI from 'openai'
import { createInferenceFetch } from '@wrenly/inference'
import { parseEditInput, parseEditCompletion, EditContractError, type EditOutput } from '@wrenly/inference'
import { EDIT_SYSTEM_PROMPT } from './edit-prompt'

// ─── Types ────────────────────────────────────────────────────────────────────
// These package-local contracts describe tool data, not API admission authority.

export type FileTree = Array<{
  path: string
  content: string
}>

export type AgentInput = {
  skills_v1?: SkillGuidance
  prompt: string
  previousErrors: string[]  // empty on attempt 1, filled on retries
  attempt: number
}

export type AgentOutput = {
  files: FileTree
}

// ─── Model client ─────────────────────────────────────────────────────────────
// OpenAI SDK with configurable base URL — this is what makes it provider-agnostic.
// Ollama exposes an OpenAI-compatible API at localhost:11434/v1.
// To switch to Groq: WRENLY_MODEL_BASE_URL=https://api.groq.com/openai/v1
// To switch to OpenAI: WRENLY_MODEL_BASE_URL=https://api.openai.com/v1

const inferenceBaseUrl = process.env.WRENLY_MODEL_BASE_URL ?? 'http://localhost:11434/v1'
const inferenceScope = process.env.WRENLY_MODEL_NETWORK_SCOPE
if (inferenceScope !== undefined && inferenceScope !== 'local' && inferenceScope !== 'cloud') throw new Error('WRENLY_MODEL_NETWORK_SCOPE must be local or cloud.')
const client = new OpenAI({
  maxRetries: 0,
  fetch: createInferenceFetch({ baseUrl: inferenceBaseUrl, timeoutMs: Number(process.env.WRENLY_MODEL_TIMEOUT_SECONDS ?? '180') * 1000, kind: inferenceScope ?? (new URL(inferenceBaseUrl).protocol === 'http:' ? 'local' : 'cloud') }),
  baseURL: process.env.WRENLY_MODEL_BASE_URL ?? 'http://localhost:11434/v1',
  // Ollama doesn't validate API keys but the SDK requires a non-empty string.
  // Real providers read this from WRENLY_MODEL_API_KEY.
  apiKey: process.env.WRENLY_MODEL_API_KEY ?? 'ollama',
})

// qwen2.5-coder:14b — strong at following JSON format instructions,
// good at multi-file Next.js code generation, runs well on consumer hardware.
const MODEL = process.env.WRENLY_MODEL_NAME ?? 'qwen2.5-coder:14b'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// ─── System prompt ────────────────────────────────────────────────────────────
// Every instruction exists for a specific reason.
// The explicit JSON-only instruction is critical — local models tend to
// wrap output in markdown fences or add explanation text without it.

const SYSTEM_PROMPT = `You are a Next.js code generator. Your only job is to generate complete, working Next.js 15 applications.

OUTPUT FORMAT — NON-NEGOTIABLE:
Return ONLY a JSON array. No markdown. No explanation. No code fences. Nothing before or after the array.

Each item in the array must have exactly these two fields:
{ "path": "relative/path/to/file.tsx", "content": "full file content as a string" }

REQUIRED FILES — always include every one of these:
- package.json (must include ALL dependencies the app uses)
- tsconfig.json
- next.config.ts
- app/layout.tsx (must include <html> and <body> tags)
- app/page.tsx
- app/globals.css
- tailwind.config.ts (content includes ./app/**/*.{js,ts,jsx,tsx,mdx}, ./src/**/*.{js,ts,jsx,tsx,mdx}, ./components/**/*.{js,ts,jsx,tsx,mdx})
- postcss.config.mjs (export default { plugins: { tailwindcss: {}, autoprefixer: {} } })

TECHNICAL REQUIREMENTS:
- Browser fetch calls must check response.ok and validate expected JSON shapes before updating state. Keep list state an array; render visible retryable errors instead of crashing or silently pretending a request succeeded.
- Next.js 15 App Router — never use the pages/ directory
- TypeScript for application files; postcss.config.mjs is JavaScript tooling configuration
- Use Tailwind CSS 3.4: tailwindcss ^3.4.0, postcss ^8.4.0 and autoprefixer ^10.4.0 in package.json. Do not mix Tailwind 4 syntax/plugins with Tailwind 3.
- globals.css must contain @tailwind base; @tailwind components; @tailwind utilities; and app/layout.tsx must import ./globals.css. Installing Tailwind alone does not process styles.
- next must be "^15.1.0" or newer — never 15.0.x (its React peer range only allows a React 19 release candidate, so npm refuses to install it next to stable React 19)
- React 19 and STABLE release versions only — never use -rc, -canary, -next, -experimental or dated prerelease tags (invented versions like 19.0.0-rc-62095389-20241024 fail the install immediately)
- package.json must have: { "scripts": { "dev": "next dev", "build": "next build", "start": "next start" } }
- Every import must resolve from a package listed in package.json dependencies
- Do not reference files not included in your response
- Do not use external APIs that require secret keys
- Local previews block external images/video/fonts/scripts and external API requests. Use bundled assets under public/, inline SVG or CSS illustrations; include every referenced local asset. Do not invent stock-photo URLs or claim to have browsed for media.`

// ─── User message builder ─────────────────────────────────────────────────────
// Attempt 1: clean prompt.
// Attempt 2+: prompt + errors from previous attempts so the agent self-corrects.
// Passing errors back is what makes the retry loop valuable — the agent
// doesn't retry blind, it retries knowing exactly what went wrong.

function buildUserMessage(input: AgentInput): string {
  const base = `Build this application: ${input.prompt}`

  if (input.previousErrors.length === 0) {
    return base
  }

  const errorBlock = input.previousErrors
    .map((err, i) => `Error from attempt ${i + 1}:\n${err}`)
    .join('\n\n')

  return `${base}

IMPORTANT — your previous attempt failed to build. Fix ALL of these errors:

${errorBlock}

Most common causes:
- Missing dependency in package.json
- Import referencing a file not included in your response
- TypeScript type error
- Wrong or missing script in package.json`
}

// ─── Response parser ──────────────────────────────────────────────────────────
// Local models frequently wrap output in code fences or add explanation text
// despite the system prompt. This parser handles the most common deviations.

function parseFileTree(response: string): FileTree {
  let cleaned = response.trim()

  // Strip markdown code fences — qwen2.5-coder sometimes adds these
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim()
  }

  // Extract outermost JSON array — handles stray text before or after
  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      'Model response contains no JSON array.'
    )
  }

  cleaned = cleaned.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new Error(
      'Model response is not valid JSON.',
      { cause: err },
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error('LLM response parsed but is not an array')
  }

  const files: FileTree = []

  for (const item of parsed) {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as Record<string, unknown>).path !== 'string' ||
      typeof (item as Record<string, unknown>).content !== 'string'
    ) {
      throw new Error(
        'Invalid file entry: expected path and content strings.'
      )
    }

    const entry = item as { path: string; content: string }
    files.push({ path: entry.path, content: entry.content })
  }

  return files
}

// ─── Main export ──────────────────────────────────────────────────────────────

/** Returns complete source or a safe failure; unfinished answers never become revisions. */
export async function generateApp(value: unknown): Promise<AgentOutput> {
  const input = parseEditInput({ ...(typeof value === 'object' && value !== null ? value : {}), version: 1, files: [{ path: 'input', content: '' }] })
  try {
    const guidance = skillGuidanceMessage(input.skills_v1)
    const response = await client.chat.completions.create({
      model: MODEL, temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT + '\n' + SKILL_AUTHORITY },
        ...(guidance ? [{ role: 'user' as const, content: guidance }] : []),
        { role: 'user', content: buildUserMessage(input) },
      ],
    })
    const choice = response.choices[0]
    if (choice?.finish_reason !== 'stop' || choice.message.refusal || !choice.message.content)
      throw new Error('Generation did not return a complete response.')
    if (Buffer.byteLength(choice.message.content) > MAX_RESPONSE_BYTES)
      throw new Error('Source response exceeds the artifact budget.')
    const files = parseFileTree(choice.message.content)
    return { files }
  } catch {
    throw new Error('Next.js generation failed. Check the selected model and complete source response.')
  }
}
/** Edits a complete frozen revision through a versioned operations contract. */
export async function editApp(value: unknown): Promise<EditOutput> {
  const input = parseEditInput(value)
  try {
    const response = await client.chat.completions.create({
      model: MODEL, temperature: 0.1, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: EDIT_SYSTEM_PROMPT + '\n' + SKILL_AUTHORITY }, { role: 'user', content: JSON.stringify(input) }],
    }, { maxRetries: 0 })
    return parseEditCompletion(response.choices[0])
  } catch (error) {
    if (error instanceof EditContractError) throw error
    throw new EditContractError('edit_model_error', 'Next.js edit generation failed. Check the selected model and structured response contract.', { cause: error })
  }
}
