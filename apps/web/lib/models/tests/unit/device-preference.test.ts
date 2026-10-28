import { expect, test } from 'bun:test'
import { clearModelSelection, getModelSelection, setModelSelection } from '../../discovery'

function withStorage(storage: Pick<Storage, 'getItem' | 'setItem'>, run: () => void): void {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
    run()
  } finally {
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor)
    else Reflect.deleteProperty(globalThis, 'window')
    if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
}

test('one atomic preference write preserves the previous pair when storage rejects a save', () => {
  const values = new Map<string, string>()
  let rejectWrite = false
  let writes = 0
  withStorage({ getItem: key => values.get(key) ?? null, setItem: (key, value) => {
    writes++
    if (rejectWrite) throw new Error('Quota exceeded')
    values.set(key, value)
  } }, () => {
    setModelSelection({ model: 'original', provider: 'original-provider' })
    expect(writes).toBe(1)
    rejectWrite = true
    expect(() => setModelSelection({ model: 'new-model', provider: 'new-provider' })).toThrow('Allow site storage')
    expect(getModelSelection()).toEqual({ model: 'original', provider: 'original-provider' })
  })
})

test('explicit default reset overrides old keys and failed reset preserves the selection', () => {
  const values = new Map([['wrenly:model', 'old-model'], ['wrenly:provider', 'old-provider']])
  let rejectWrite = true
  withStorage({ getItem: key => values.get(key) ?? null, setItem: (key, value) => {
    if (rejectWrite) throw new Error('Storage blocked')
    values.set(key, value)
  } }, () => {
    expect(() => clearModelSelection()).toThrow('Allow site storage')
    expect(getModelSelection()).toEqual({ model: 'old-model', provider: 'old-provider' })
    rejectWrite = false
    clearModelSelection()
    expect(getModelSelection()).toBeNull()
  })
})

test('blocked or malformed reads fail explicitly instead of returning no preference', () => {
  withStorage({ getItem: () => { throw new Error('Private diagnostic') }, setItem: () => {} }, () => {
    expect(() => getModelSelection()).toThrow('Allow site storage')
    try { getModelSelection() } catch (error) { expect(String(error)).not.toContain('Private diagnostic') }
  })
  withStorage({ getItem: () => '{broken', setItem: () => {} }, () => {
    expect(() => getModelSelection()).toThrow('choose a model again')
  })
})
