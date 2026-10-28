import { expect, test } from 'bun:test'
import { parseSetupSummary, type SetupSummary } from '../../setup-summary'
const summary: SetupSummary = { role: 'owner', accountConfigured: true, providerConfigured: false, hasProjects: false,
  defaultModel: { state: 'missing', modelId: null, providerLabel: null, source: null },
  preview: 'operator-setup', publishing: 'operator-setup', connectionHealth: 'not-checked' }

test('setup facts project safe fields without treating progress as a live health probe', () => {
  expect(parseSetupSummary({ ...summary, token: 'private', connectionHealth: 'not-checked' })).toEqual(summary)
  expect(() => parseSetupSummary({ ...summary, connectionHealth: 'healthy' })).toThrow('incomplete information')
})
test('missing or malformed setup state never becomes a new empty instance', () => {
  for (const value of [null, {}, { ...summary, role: 'admin' }, { ...summary, providerConfigured: 'false' },
    { ...summary, defaultModel: null }]) expect(() => parseSetupSummary(value)).toThrow()
})
