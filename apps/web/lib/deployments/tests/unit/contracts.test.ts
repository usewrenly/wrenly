import { expect, test } from 'bun:test'
import { parseDeployment, type Deployment } from '../../contracts'
const deployment: Deployment = { id: 'deployment', buildId: 'build', status: 'success', url: 'https://app.example.test', errorCode: null }
test('deployment snapshots require known state, matching revision and safe navigation', () => {
  expect(parseDeployment({ ...deployment, runtimeSecret: 'not-retained' }, 'build')).toEqual({ ...deployment, url: 'https://app.example.test/' })
  expect(parseDeployment(null, 'build')).toBeNull()
  for (const value of [undefined, { ...deployment, status: 'ready' }, { ...deployment, buildId: 'other' }, { ...deployment, url: 'javascript:alert(1)' }])
    expect(() => parseDeployment(value, 'build')).toThrow()
})
