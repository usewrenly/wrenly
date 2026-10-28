import { skillGuidanceMessage, SKILL_AUTHORITY, type SkillGuidance } from "@wrenly/inference"
//
// Laravel code generation agent.
// Uses the same OpenAI-compatible client as the Next.js agent —
// provider is swapped via environment variables, no code change needed.
//
// Generates Laravel 13 application source:
// composer.json, routes, controllers, views, and configuration.

import OpenAI from 'openai'
import { LARAVEL_SKELETON } from './skeleton'
import { createInferenceFetch } from '@wrenly/inference'
import { parseEditInput, parseEditCompletion, EditContractError, type EditOutput } from '@wrenly/inference'
import { EDIT_SYSTEM_PROMPT } from './edit-prompt'

// ─── Types ────────────────────────────────────────────────────────────────────

export type FileTree = Array<{
  path: string
  content: string
}>

export type AgentInput = {
  skills_v1?: SkillGuidance
  prompt: string
  previousErrors: string[]
  attempt: number
}

export type AgentOutput = {
  files: FileTree
  build_command?: string
  start_command?: string
}

// ─── Client ───────────────────────────────────────────────────────────────────
// Identical setup to nextjs-agent — one model provider config, all agents.

const inferenceBaseUrl = process.env.WRENLY_MODEL_BASE_URL ?? 'http://localhost:11434/v1'
const inferenceScope = process.env.WRENLY_MODEL_NETWORK_SCOPE
if (inferenceScope !== undefined && inferenceScope !== 'local' && inferenceScope !== 'cloud') throw new Error('WRENLY_MODEL_NETWORK_SCOPE must be local or cloud.')
const client = new OpenAI({
  maxRetries: 0,
  fetch: createInferenceFetch({ baseUrl: inferenceBaseUrl, timeoutMs: Number(process.env.WRENLY_MODEL_TIMEOUT_SECONDS ?? '180') * 1000, kind: inferenceScope ?? (new URL(inferenceBaseUrl).protocol === 'http:' ? 'local' : 'cloud') }),
  baseURL: process.env.WRENLY_MODEL_BASE_URL ?? 'http://localhost:11434/v1',
  apiKey: process.env.WRENLY_MODEL_API_KEY ?? 'ollama',
})

const MODEL = process.env.WRENLY_MODEL_NAME ?? 'qwen2.5-coder:14b'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

// ─── System prompt ────────────────────────────────────────────────────────────
// Laravel-specific instructions. The LLM must generate PHP, not JavaScript.
// Required files differ significantly from Next.js — this prompt is precise.

const SYSTEM_PROMPT = `Generate a complete Laravel 13 / PHP 8.4 application using Blade.
Return ONLY a JSON array of {"path":"relative/path","content":"complete file content"}.
Required: composer.json, artisan, bootstrap/app.php, bootstrap/providers.php,
config/app.php, config/session.php, config/cache.php, config/logging.php,
routes/web.php, routes/console.php, public/index.php, public/app.css,
resources/views/welcome.blade.php, .env.example.
Use Laravel 13 Application::configure()->withRouting(web:...,commands:...,health:'/up')
withMiddleware and withExceptions. CLI artisan uses handleCommand(new ArgvInput).
public/index.php loads vendor/autoload.php then bootstrap/app.php and handleRequest.
composer.json requires php ^8.4 and laravel/framework ^13.0 with PSR-4 App\\ mapping.
No Composer scripts, plugins, repositories or advisory policy overrides.
config/app.php must provide name, env, debug, url, key from env('APP_KEY'), cipher AES-256-CBC.
Use file sessions, array cache and stderr logging by default; include those configs.
.env.example contains no secrets or placeholder APP_KEY; runtime injects APP_KEY.
Do not create a .env file. No database, queue or external API connectivity is provisioned.
Do not pretend persistent features work without separately configured resources.
Use locally included public/app.css linked by /app.css. Build a polished responsive UI
with CSS and Blade. No CDN, remote fonts/scripts, installation hooks or remote assets.
Images/video must be included local assets, inline SVG or CSS illustrations, not invented stock-photo URLs. Local previews block remote media. No browser/search tool is available; do not claim to have fetched media.
Tailwind class names alone do not provide styling. Either write the complete equivalent
CSS in public/app.css, or include Tailwind dependencies, all input/config files and an
offline build script that emits the stylesheet actually linked by Blade. Never serve
raw @tailwind, @apply or @import "tailwindcss" source as the final public stylesheet.
Optional asset compilation uses package.json with a build script; Wrenly installs with
scripts disabled and compiles offline. All referenced source must be included.
UTF-8 text is allowed. Never return ellipses, placeholders or generated shell commands.`

// ─── User message builder ─────────────────────────────────────────────────────

function buildUserMessage(input: AgentInput): string {
  const base = `Build this Laravel application: ${input.prompt}`

  if (input.previousErrors.length === 0) {
    return base
  }

  const errorBlock = input.previousErrors
    .map((err, i) => `Error from attempt ${i + 1}:\n${err}`)
    .join('\n\n')

  return `${base}

IMPORTANT — your previous attempt failed to build. Fix ALL of these errors:

${errorBlock}

Check missing views, invalid PHP syntax, namespace escaping, unsupported dependency policy,
missing local assets and framework configuration. Preserve the requested behavior.`
}

// ─── Response parser ──────────────────────────────────────────────────────────
// Identical logic to the Next.js agent parser — LLM format issues are universal.

function parseFileTree(response: string): FileTree {
  let cleaned = response.trim()

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch?.[1]) {
    cleaned = fenceMatch[1].trim()
  }

  const start = cleaned.indexOf('[')
  const end = cleaned.lastIndexOf(']')

  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      `LLM response contains no JSON array. Preview: ${cleaned.slice(0, 200)}`
    )
  }

  cleaned = cleaned.slice(start, end + 1)

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    throw new Error(
      `LLM response is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
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
      throw new Error(`Invalid file entry: ${JSON.stringify(item)}`)
    }
    const entry = item as { path: string; content: string }
    files.push({ path: entry.path, content: entry.content })
  }

  return files
}

// ─── JSON file repair ─────────────────────────────────────────────────────────

/**
 * Escapes backslashes that appear unescaped inside JSON string values — the
 * most common way the model corrupts composer.json. PHP namespaces such as
 * Illuminate\Foundation\ComposerScripts need `\\` inside the file, and the
 * model frequently emits a single `\` (an invalid JSON escape like `\F`).
 * Characters that are already valid are copied untouched.
 *
 * This is a best-effort mechanical fix — callers must JSON.parse the result
 * to confirm it is usable.
 */
export function escapeInvalidBackslashes(raw: string): string {
  let result = ''
  let insideString = false

  for (let i = 0; i < raw.length; i++) {
    const char = raw.charAt(i)

    if (!insideString) {
      if (char === '"') insideString = true
      result += char
      continue
    }

    if (char === '\\') {
      const next = i + 1 < raw.length ? raw.charAt(i + 1) : undefined
      if (next !== undefined && '"\\/bfnrtu'.includes(next)) {
        // Valid JSON escape (\n, \", \\, \uXXXX …) — keep both characters
        result += char + next
        i++
      } else {
        // Invalid escape — double the backslash itself, then copy the rest
        result += '\\\\'
        if (next !== undefined) {
          result += next
          i++
        }
      }
      continue
    }

    if (char === '"') insideString = false
    result += char
  }

  return result
}

/**
 * Ensures every .json file in a generated tree actually parses. LLMs
 * reliably mis-nest backslash escaping when JSON content lives inside a JSON
 * response (composer.json + PHP namespaces). Mechanically repairable files
 * are fixed here — before anything is streamed, sandboxed, or pushed to git.
 * Files that still do not parse are returned untouched on purpose: the
 * sandbox's file-tree validation rejects them and the orchestrator feeds the
 * exact parse error back to the model on the next attempt.
 */
export function repairJsonFiles(files: FileTree): FileTree {
  return files.map((file) => {
    if (!file.path.endsWith('.json')) return file

    try {
      JSON.parse(file.content)
      return file
    } catch {
      const repaired = escapeInvalidBackslashes(file.content)
      try {
        JSON.parse(repaired)
        return { path: file.path, content: repaired }
      } catch {
        return file
      }
    }
  })
}

// ─── Main export ──────────────────────────────────────────────────────────────

/** Generates bounded source; execution and validation belong to the Docker sandbox. */
export async function generateApp(value: unknown): Promise<AgentOutput> {
  const input = parseEditInput({ ...(typeof value === 'object' && value !== null ? value : {}), version: 1, files: [{ path: 'input', content: '' }] })
  try {
    const response = await client.chat.completions.create({
      model: MODEL, temperature: 0.1,
      messages: [{ role: 'system', content: SYSTEM_PROMPT + '\n' + SKILL_AUTHORITY + '\nAvailable default skeleton (override explicitly only when needed):\n' + JSON.stringify(LARAVEL_SKELETON) }, ...(skillGuidanceMessage(input.skills_v1) ? [{ role: 'user' as const, content: skillGuidanceMessage(input.skills_v1) }] : []), { role: 'user', content: buildUserMessage(input) }],
    })
    const choice = response.choices[0]
    if (choice?.finish_reason !== 'stop' || choice.message.refusal || !choice.message.content)
      throw new Error('Laravel generation did not return a complete response.')
    if (Buffer.byteLength(choice.message.content) > MAX_RESPONSE_BYTES)
      throw new Error('Laravel source response exceeds the artifact budget.')
    const generated = repairJsonFiles(parseFileTree(choice.message.content))
    const paths = new Set(generated.map(file => file.path))
    if (paths.size !== generated.length) throw new Error('Duplicate generated source paths.')
    return { files: [...LARAVEL_SKELETON.filter(file => !paths.has(file.path)), ...generated],
      build_command: 'php artisan view:cache', start_command: 'frankenphp run --config /wrenly/Caddyfile' }
  } catch {
    throw new Error('Laravel generation failed. Check the selected model and complete source response.')
  }
}

/** Applies explicit operations to a complete revision; omitted files remain unchanged. */
export async function editApp(value: unknown): Promise<EditOutput> {
  const input = parseEditInput(value)
  let manifest: unknown
  try { manifest = JSON.parse(input.files.find(file => file.path === 'composer.json')?.content ?? 'null') }
  catch { throw new EditContractError('invalid_edit_input', 'Laravel editing requires a valid composer.json.') }
  const requirements = typeof manifest === 'object' && manifest !== null && 'require' in manifest ? manifest.require : null
  const framework = typeof requirements === 'object' && requirements !== null && 'laravel/framework' in requirements
    ? requirements['laravel/framework'] : null
  if (typeof framework !== 'string' || !/^\^13\.\d+(?:\.\d+)?$/.test(framework))
    throw new EditContractError('invalid_edit_input', 'Laravel editing requires an existing Laravel 13 revision; older projects are never silently upgraded.')
  try {
    const response = await client.chat.completions.create({ model: MODEL, temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: EDIT_SYSTEM_PROMPT + '\n' + SKILL_AUTHORITY }, { role: 'user', content: JSON.stringify(input) }],
    })
    return parseEditCompletion(response.choices[0])
  } catch (error) {
    if (error instanceof EditContractError) throw error
    throw new EditContractError('edit_model_error', 'Laravel editing model request failed.')
  }
}
