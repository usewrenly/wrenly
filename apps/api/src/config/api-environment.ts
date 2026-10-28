// COMPONENT: API startup configuration
// PURPOSE: Reject missing API configuration before opening database/auth services.
// INPUTS: Environment variables.
// OUTPUTS: Validated API listener/auth configuration, without logging values.
// STEPS: Parse with Zod; report variable names and validation messages on failure.
// EDGE CASES: Default host is local-only; containers can explicitly bind 0.0.0.0.
// ERROR STATES: Invalid config prevents startup.

import { z } from 'zod'
import { resolve } from 'node:path'
const OptionalPublishingString = z.preprocess(value => value === '' ? undefined : value, z.string().min(1).optional())

const ApiEnvironmentSchema = z.object({
  WRENLY_DATA_DIR: z.string().min(1).default('.local/wrenly').transform(value => resolve(value)),
  WRENLY_DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//),
  WRENLY_AUTH_SECRET: z.string().min(1),
  WRENLY_APP_URL: z.url(),
  WRENLY_WEB_URL: z.url().default('http://localhost:3000'),
  WRENLY_SINGLE_USER_MODE: z.enum(['true', 'false']).default('false'),
  WRENLY_DEPLOY_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/i, 'Must contain exactly 64 hexadecimal digits.').optional(),
  WRENLY_PUBLISHING_ENABLED: z.enum(['true', 'false']).default('false'),
  WRENLY_REGISTRY_URL: OptionalPublishingString,
  WRENLY_REGISTRY_NAMESPACE: z.string().regex(/^[a-z0-9_-]{1,100}$/).default('wrenly'),
  WRENLY_REGISTRY_USERNAME: OptionalPublishingString,
  WRENLY_REGISTRY_PASSWORD: OptionalPublishingString,
  WRENLY_GIT_BASE_URL: OptionalPublishingString,
  WRENLY_GIT_TOKEN: OptionalPublishingString,
  WRENLY_GIT_ORG: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).default('wrenly-apps'),
  WRENLY_COOLIFY_API_URL: OptionalPublishingString,
  WRENLY_COOLIFY_API_KEY: OptionalPublishingString,
  WRENLY_COOLIFY_PROJECT_UUID: OptionalPublishingString,
  WRENLY_COOLIFY_SERVER_UUID: OptionalPublishingString,
  WRENLY_COOLIFY_ENVIRONMENT: z.string().min(1).default('production'),
  WRENLY_APP_DATABASES_ENABLED: z.enum(['true', 'false']).default('false'),
  WRENLY_PREVIEW_ENABLED: z.enum(['true', 'false']).default('false'),
  WRENLY_PREVIEW_BASE_URL: z.url().default('http://wrenly-preview.localhost:3003'),
  WRENLY_PREVIEW_GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(3003),
  WRENLY_API_HOST: z.string().min(1).default('127.0.0.1'),
  WRENLY_MODEL_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(600).default(180),
  WRENLY_API_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  WRENLY_SANDBOX_MEMORY_LIMIT: z.string().regex(/^[1-9]\d*[kmg]?$/i).refine((value) => {
    const unit = value.slice(-1).toLowerCase()
    const multipliers: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 }
    const bytes = Number(multipliers[unit] ? value.slice(0, -1) : value) * (multipliers[unit] ?? 1)
    return Number.isSafeInteger(bytes) && bytes > 0
  }, 'Memory limit must resolve to a safe positive byte count.').default('2048m'),
  WRENLY_SANDBOX_CPU_LIMIT: z.coerce.number().positive().finite().refine((value) => Number.isSafeInteger(value * 1_000_000_000), 'CPU limit must resolve to a safe NanoCPU count.').default(2),
  WRENLY_SANDBOX_TIMEOUT_SECONDS: z.coerce.number().int().positive().max(300).default(300),
})

export type ApiEnvironment = z.infer<typeof ApiEnvironmentSchema>

/** Validates control-plane settings without echoing secrets into startup errors. */
export function parseApiEnvironment(
  input: Record<string, unknown>,
): ApiEnvironment {
  const parsed = ApiEnvironmentSchema.safeParse(input)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ')
    throw new Error(
      `Invalid API configuration: ${issues}. Update the repository-root .env or the service environment.`,
    )
  }
  if (parsed.data.WRENLY_APP_DATABASES_ENABLED === 'true' && parsed.data.WRENLY_PREVIEW_ENABLED !== 'true')
    throw new Error('WRENLY_APP_DATABASES_ENABLED requires WRENLY_PREVIEW_ENABLED=true and verified local database toolchains.');
  if (parsed.data.WRENLY_PREVIEW_ENABLED === 'true') {
    if (parsed.data.WRENLY_AUTH_SECRET.length < 32) throw new Error('Local previews require WRENLY_AUTH_SECRET with at least 32 characters.')
    const base = new URL(parsed.data.WRENLY_PREVIEW_BASE_URL)
    const control = new URL(parsed.data.WRENLY_WEB_URL)
    const api = new URL(parsed.data.WRENLY_APP_URL)
    const local = ['localhost', '127.0.0.1'].includes(control.hostname) && base.hostname === 'wrenly-preview.localhost' && ['localhost', '127.0.0.1'].includes(api.hostname)
    if (base.username || base.password || base.pathname !== '/' || base.search || base.hash || base.hostname === control.hostname ||
      (!local && (base.protocol !== 'https:' || control.protocol !== 'https:' ||
        [control, api].some(origin => origin.protocol !== 'https:' || base.hostname.split('.').slice(-2).join('.') === origin.hostname.split('.').slice(-2).join('.')))))
      throw new Error('Preview configuration requires local wrenly-preview.localhost or HTTPS on a separate preview domain from WRENLY_WEB_URL.')
    if (local && (base.protocol !== 'http:' || Number(base.port) !== parsed.data.WRENLY_PREVIEW_GATEWAY_PORT))
      throw new Error('Local preview base URL port must match WRENLY_PREVIEW_GATEWAY_PORT.')
  }
  if (parsed.data.WRENLY_PUBLISHING_ENABLED === 'true') {
    const required = ['WRENLY_DEPLOY_ENCRYPTION_KEY', 'WRENLY_REGISTRY_URL', 'WRENLY_REGISTRY_USERNAME', 'WRENLY_REGISTRY_PASSWORD',
      'WRENLY_COOLIFY_API_URL', 'WRENLY_COOLIFY_API_KEY', 'WRENLY_COOLIFY_PROJECT_UUID', 'WRENLY_COOLIFY_SERVER_UUID', 'WRENLY_GIT_BASE_URL', 'WRENLY_GIT_TOKEN'] as const
    const missing = required.filter(name => !parsed.data[name])
    if (missing.length) throw new Error(`Publishing requires ${missing.join(', ')}. Update the repository-root .env or the service environment.`)
    for (const name of ['WRENLY_COOLIFY_PROJECT_UUID', 'WRENLY_COOLIFY_SERVER_UUID'] as const) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(parsed.data[name]!)) throw new Error(`${name} must be a valid provider identifier.`)
    }
    if (/[\r\n:]/.test(parsed.data.WRENLY_REGISTRY_USERNAME!) || /[\r\n]/.test(parsed.data.WRENLY_REGISTRY_PASSWORD!) ||
      [parsed.data.WRENLY_GIT_TOKEN!, parsed.data.WRENLY_COOLIFY_API_KEY!].some(value => value.length > 16000 || /[\r\n]/.test(value)))
      throw new Error('Publishing credentials have invalid formatting.')
    for (const name of ['WRENLY_REGISTRY_URL', 'WRENLY_COOLIFY_API_URL', 'WRENLY_GIT_BASE_URL'] as const) {
      let url: URL
      try { url = new URL(parsed.data[name]!) } catch { throw new Error(`${name} must be a valid HTTP(S) origin.`) }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !(url.pathname === '/' || name === 'WRENLY_COOLIFY_API_URL' && url.pathname.replace(/\/$/, '') === '/api/v1'))
        throw new Error(`${name} must be an HTTP(S) origin without credentials or arbitrary paths.`)
      if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
        throw new Error(`${name} requires HTTPS except for a loopback development service.`)
    }
  }
  return parsed.data
}
