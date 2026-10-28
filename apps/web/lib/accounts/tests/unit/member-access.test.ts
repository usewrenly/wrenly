import { expect, test } from 'bun:test'
import { parseAccountAccess } from '../../member-access'
const member = { id: 'membership', userId: 'user', name: 'Member', email: 'member@example.test', role: 'member', suspended: false, accessRevision: 'revision' }

test('member metadata is projected without inventing missing status or authority', () => {
  expect(parseAccountAccess({ members: [{ ...member, privateField: 'not-retained' }], invitations: [] }).members[0]).toEqual(member)
  const unknown = parseAccountAccess({ members: [{ id: 'membership', name: 'Member', email: 'member@example.test', role: 'member' }], invitations: [] }).members[0]
  expect(unknown?.suspended).toBeUndefined()
  expect(unknown?.accessRevision).toBeUndefined()
})
test('malformed member flags and contradictory owner metadata fail closed', () => {
  for (const change of [{ suspended: 'false' }, { accessRevision: {} }, { userId: 42 }, { isOwner: 'false' }, { role: 'owner', isOwner: false }]) {
    expect(() => parseAccountAccess({ members: [{ ...member, ...change }], invitations: [] })).toThrow('metadata')
  }
})
