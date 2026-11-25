import { expect, test } from 'bun:test'
import { validateNextjsStyling } from '../src/source-policy/nextjs-styling'
import { nextjs16Fixture } from './nextjs-generation-fixture'

test('Next.js 16 generation fixture satisfies Tailwind 3.4 styling preflight', () => {
  expect(() => validateNextjsStyling(nextjs16Fixture())).not.toThrow()
})
