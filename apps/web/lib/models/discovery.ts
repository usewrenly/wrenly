// Discovers model choices through Wrenly; provider credentials stay on the server.
// A device override is explicit. Missing defaults never select a different provider.

import { apiFetch } from '@/lib/api'

import { z } from 'zod'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

export type ModelKind = 'local' | 'cloud'

export interface ModelOption {
  id: string
  label: string
  kind: ModelKind
  provider: string
}

export interface ProviderStatus {
  id: string
  label: string
  kind: ModelKind
  displayUrl: string
  reachable: boolean
  hint: string | null
}

export interface ModelsResponse {
  providers: ProviderStatus[]
  models: ModelOption[]
  envDefault: string
  defaultProvider?: string | null
}

export interface ModelSelection {
  model: string
  provider: string
}

const modelKindSchema = z.enum(['local', 'cloud'])
const modelsResponseSchema = z.object({
  providers: z.array(z.object({
    id: z.string(), label: z.string(), kind: modelKindSchema,
    displayUrl: z.string(), reachable: z.boolean(), hint: z.string().nullable(),
  })),
  models: z.array(z.object({
    id: z.string(), label: z.string(), kind: modelKindSchema, provider: z.string(),
  })),
  envDefault: z.string(),
  defaultProvider: z.string().nullable().optional(),
})

/** Rejects malformed discovery before pickers use it; retains only public model metadata. */
export function parseModelsResponse(value: unknown): ModelsResponse {
  const parsed = modelsResponseSchema.safeParse(value)
  if (!parsed.success) throw new Error('Model discovery returned an unreadable response. Refresh and try again.')
  return parsed.data
}

const MODEL_DISCOVERY_STALE_MS = 30_000 // Reflect service restarts without probing on every render.
const MODEL_KEY = 'wrenly:model'
const PROVIDER_KEY = 'wrenly:provider'

const SELECTION_KEY = 'wrenly:model-selection'
const preferenceSchema = z.object({ model: z.string().min(1), provider: z.string().min(1) })

function preferenceError(): Error {
  return new Error('Your browser could not read or save the model preference. Allow site storage and choose a model again.')
}

/** Reads an explicit pair; storage failure must not silently switch to an instance default. */
export function getModelSelection(): ModelSelection | null {
  if (typeof window === 'undefined') return null
  try {
    const saved = localStorage.getItem(SELECTION_KEY)
    if (saved !== null) {
      const value: unknown = JSON.parse(saved)
      return value === null ? null : preferenceSchema.parse(value)
    }
    // Read pre-existing device choices; new saves use one atomic record instead.
    const model = localStorage.getItem(MODEL_KEY)
    const provider = localStorage.getItem(PROVIDER_KEY)
    return model && provider ? { model, provider } : null
  } catch { throw preferenceError() }
}

/** Writes the pair atomically so a failed second write cannot mix providers and models. */
export function setModelSelection(selection: ModelSelection): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(preferenceSchema.parse(selection)))
  } catch { throw preferenceError() }
}

/** An explicit null overrides older keys without a partially completed multi-key removal. */
export function clearModelSelection(): void {
  if (typeof window === 'undefined') return
  try { localStorage.setItem(SELECTION_KEY, 'null') } catch { throw preferenceError() }
}

/**
 * Discovers available models via the server-side provider probes.
 * Short cache: providers come up and down (an Ollama restart should be
 * visible without a full reload) but every keystroke must not re-probe.
 */
export function useModels(): UseQueryResult<ModelsResponse, Error> {
  return useQuery({
    queryKey: ['models'],
    queryFn: async (): Promise<ModelsResponse> => {
      const res = await apiFetch('/api/models', { credentials: 'include' })
      if (!res.ok) throw new Error(`Model discovery failed (${res.status})`)
      return parseModelsResponse(await res.json())
    },
    staleTime: MODEL_DISCOVERY_STALE_MS,
    retry: 1,
  })
}

/** Preserves explicit choices and matches the instance default by provider/model pair without silent rerouting. */
export function resolveSelection(data: ModelsResponse | undefined, savedSelection: ModelSelection | null = getModelSelection()): ModelSelection | null {
  if (!data) return null
  const saved = savedSelection
  if (saved) return saved
  if ('defaultProvider' in data) {
    if (data.defaultProvider) {
      const selected = data.models.find(model => model.provider === data.defaultProvider && model.id === data.envDefault)
      return selected ? { model: selected.id, provider: selected.provider } : null
    }
    return null
  }
  // Older responses cannot disambiguate identical model IDs on different providers.
  return null
}
