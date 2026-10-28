import { describe, expect, test } from 'bun:test'
import { parseEditInput, parseEditOutput, parseEditCompletion, EditContractError } from '../../src/contracts/edit-contract'
const input = { version: 1, prompt: 'Change the heading', files: [{ path: 'app/page.tsx', content: 'Existing' }], attempt: 1, previousErrors: [] }

describe('Shared MCP edit contract', () => {
  test('distinguishes truncated, unfinished, invalid JSON and invalid contract without leaking content', () => {
    for (const [choice, code] of [
      [{ finish_reason: 'length', message: { content: 'private-partial-source' } }, 'edit_response_truncated'],
      [{ finish_reason: 'content_filter', message: { content: 'private-source' } }, 'edit_response_unfinished'],
      [{ finish_reason: 'stop', message: { content: 'private-invalid-json' } }, 'invalid_edit_json'],
      [{ finish_reason: 'stop', message: { content: '{"files":[],"private":"secret"}' } }, 'invalid_edit_output'],
    ] as const) {
      try { parseEditCompletion(choice); throw new Error('Expected rejection') } catch (error) {
        expect(error).toBeInstanceOf(EditContractError)
        expect((error as EditContractError).code).toBe(code)
        expect(String(error)).not.toContain('private')
      }
    }
    expect(parseEditCompletion({ finish_reason: 'stop', message: { content: '{"version":1,"operations":[]}' } })).toEqual({ version: 1, operations: [] })
  })
  test('accepts a complete versioned source snapshot and explicit update output', () => {
    expect(parseEditInput(input).files).toEqual(input.files)
    expect(parseEditOutput(JSON.stringify({ version: 1, operations: [{ type: 'update', path: 'app/page.tsx', content: 'Changed' }] })).operations).toHaveLength(1)
  })
  test('rejects partial/unsafe/oversized input before model inference', () => {
    for (const value of [{ ...input, version: 2 }, { ...input, files: [] }, { ...input, files: [{ path: '../escape', content: 'x' }] },
      { ...input, files: [{ path: 'app', content: '' }, ...input.files] }, { ...input, files: [{ path: 'large.ts', content: 'x'.repeat(128000) }] }, { ...input, command: 'deploy' }])
      expect(() => parseEditInput(value)).toThrow()
  })
  test('rejects full generation arrays, commands, duplicate operations and delete content', () => {
    for (const value of [input.files, { version: 1, operations: [{ type: 'execute', path: 'app/page.tsx' }] },
      { version: 1, operations: [{ type: 'delete', path: 'app/page.tsx', content: 'extra' }] },
      { version: 1, operations: [{ type: 'delete', path: 'app/page.tsx' }, { type: 'delete', path: 'app/page.tsx' }] }])
      expect(() => parseEditOutput(JSON.stringify(value))).toThrow()
  })
})

test('whole JSON fences are formatting only; prose and incomplete or unsafe payloads remain rejected', () => {
  const valid = '{"version":1,"operations":[{"type":"update","path":"app/page.tsx","content":"safe"}]}'
  expect(parseEditOutput('```json\n' + valid + '\n```')).toEqual(parseEditOutput(valid))
  expect(parseEditOutput(' \n' + valid + '\n ')).toEqual(parseEditOutput(valid))
  for (const output of ['Here is the edit: '+valid, '```json\n'+valid, '```json\n{"version":1,"operations":[{"type":"execute","path":"app/page.tsx"}]}\n```', valid+'\n'+valid]) expect(()=>parseEditOutput(output)).toThrow()
});
