import { expect, test } from 'bun:test'
import { getModelSelection, parseModelsResponse, resolveSelection, type ModelsResponse } from '../../discovery'
test('instance default selects its provider as well as its model identity', () => {
  const data: ModelsResponse = { providers: [], models: [{ id: 'same-model', label: 'A', kind: 'cloud', provider: 'a' }, { id: 'same-model', label: 'B', kind: 'cloud', provider: 'b' }], envDefault: 'same-model', defaultProvider: 'b' }
  expect(resolveSelection(data, null)).toEqual({ model: 'same-model', provider: 'b' })
  expect(resolveSelection(data, { model: 'removed-model', provider: 'removed-provider' })).toEqual({ model: 'removed-model', provider: 'removed-provider' })
})
test('missing or disabled instance defaults never silently choose the first offered model', () => {
  const data: ModelsResponse = { providers: [], models: [{ id: 'paid-model', label: 'Paid', kind: 'cloud', provider: 'paid' }], envDefault: '', defaultProvider: null }
  expect(resolveSelection(data, null)).toBeNull()
  expect(resolveSelection({ ...data, envDefault: 'missing', defaultProvider: 'disabled' }, null)).toBeNull()
})

test('suppressed legacy default cannot select the same model ID from another connection', () => {
  expect(resolveSelection({ providers: [], models: [{ id: 'same-model', label: 'Same', kind: 'cloud', provider: 'another-paid-provider' }], envDefault: 'same-model', defaultProvider: null }, null)).toBeNull()
})

test('an older response without provider identity never selects the first paid model', () => {
  expect(resolveSelection({ providers: [], models: [{ id: 'paid', label: 'Paid', kind: 'cloud', provider: 'paid-provider' }], envDefault: 'paid' }, null)).toBeNull()
})

test('discovery rejects malformed metadata and strips unrelated credential fields', () => {
  const valid = { providers: [], models: [{ id: 'model', label: 'Model', kind: 'cloud', provider: 'provider', token: 'not-for-browser-state' }], envDefault: 'model', defaultProvider: 'provider' }
  expect(parseModelsResponse(valid).models[0]).not.toHaveProperty('token')
  expect(() => parseModelsResponse({ ...valid, models: [{ id: 'model', kind: 'cloud' }] })).toThrow('unreadable response')
  expect(() => parseModelsResponse({ ...valid, providers: [{ reachable: 'true' }] })).toThrow('unreadable response')
})

test('a legacy device model without provider identity is not rerouted to Ollama', () => {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const values = new Map([['wrenly:model', 'model']])
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true,
      value: { getItem: (key: string): string | null => values.get(key) ?? null } })
    expect(getModelSelection()).toBeNull()
    values.set('wrenly:provider', 'explicit-provider')
    expect(getModelSelection()).toEqual({ model: 'model', provider: 'explicit-provider' })
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
