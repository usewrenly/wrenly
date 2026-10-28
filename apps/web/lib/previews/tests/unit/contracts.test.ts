import { expect, test } from 'bun:test'
import { parsePreview, type LocalPreview } from '../../contracts'
const preview: LocalPreview = { id: 'preview', buildId: 'build', status: 'ready', log: 'Ready', error: null, cleanupPending: false }
test('preview contract rejects missing cleanup and unknown states', () => {
  expect(parsePreview({ ...preview, internalField: 'not-retained' })).toEqual(preview)
  expect(parsePreview(null)).toBeNull()
  const { cleanupPending: _cleanup, ...incomplete } = preview
  for (const value of [undefined, incomplete, { ...preview, cleanupPending: 'false' }, { ...preview, status: 'complete' }])
    expect(() => parsePreview(value)).toThrow('Invalid preview snapshot')
})
