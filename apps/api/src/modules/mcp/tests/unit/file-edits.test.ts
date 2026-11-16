import { describe, expect, test } from 'bun:test'
import { applyFileEdits, validateEditContext } from '../../file-edits'
const base = [{ path: 'package.json', content: '{}' }, { path: 'app/page.tsx', content: 'Original' }, { path: 'app/other.tsx', content: 'Keep me' }]

describe('revision-safe file edits', () => {
  test('merges explicit operations and preserves omitted files and the immutable base', () => {
    const merged = applyFileEdits(base, { version: 1, operations: [
      { type: 'update', path: 'app/page.tsx', content: 'Changed' }, { type: 'create', path: 'app/new.tsx', content: 'New' },
    ] })
    expect(merged.find(file => file.path === 'app/other.tsx')?.content).toBe('Keep me')
    expect(merged.find(file => file.path === 'app/page.tsx')?.content).toBe('Changed')
    expect(merged.find(file => file.path === 'app/new.tsx')?.content).toBe('New')
    expect(base[1]?.content).toBe('Original'); expect(base).toHaveLength(3)
  })
  test('requires explicit deletion and permits an unchanged revision', () => {
    expect(applyFileEdits(base, { version: 1, operations: [] })).toEqual(base)
    expect(applyFileEdits(base, { version: 1, operations: [{ type: 'delete', path: 'app/other.tsx' }] }).some(file => file.path === 'app/other.tsx')).toBe(false)
  })
  test('rejects conflicting operations and existence errors without partially modifying the base', () => {
    for (const operations of [
      [{ type: 'create', path: 'package.json', content: 'Overwrite' }], [{ type: 'update', path: 'missing.ts', content: 'New' }], [{ type: 'delete', path: 'missing.ts' }],
      [{ type: 'update', path: 'app/page.tsx', content: 'Changed' }, { type: 'delete', path: 'app/page.tsx' }],
    ]) expect(() => applyFileEdits(base, { version: 1, operations })).toThrow()
    expect(base[1]?.content).toBe('Original')
  })
  test('rejects escaping paths, ancestor collisions, unknown fields and unsupported versions', () => {
    for (const path of ['../escape', '/absolute', 'app/../escape', 'C:\\file', 'bad\u0000file'])
      expect(() => applyFileEdits(base, { version: 1, operations: [{ type: 'create', path, content: 'x' }] })).toThrow()
    expect(() => applyFileEdits(base, { version: 1, operations: [{ type: 'create', path: 'app', content: 'collision' }] })).toThrow('collision')
    expect(() => applyFileEdits(base, { version: 1, operations: [{ type: 'delete', path: 'app/page.tsx', content: 'extra' }] })).toThrow()
    expect(() => applyFileEdits(base, { version: 2, operations: [] })).toThrow()
  })
  test('rejects oversize complete context before inference and oversize output before validation', () => {
    expect(() => validateEditContext([{ path: 'huge.ts', content: 'x'.repeat(128000) }])).toThrow('No source was truncated')
    expect(() => applyFileEdits(base, { version: 1, operations: [{ type: 'update', path: 'app/page.tsx', content: 'x'.repeat(2 * 1024 * 1024 + 1) }] })).toThrow('artifact limits')
  })
})

test('editing preserves imported paths containing spaces and route groups', () => {
  const files = [
    { path: 'app/(marketing)/page.tsx', content: 'original page' },
    { path: 'docs/Getting started.md', content: 'keep these instructions' },
  ]
  const edited = applyFileEdits(files, { version: 1, operations: [
    { type: 'update', path: 'app/(marketing)/page.tsx', content: 'updated page' },
  ] })
  expect(edited).toEqual([{ ...files[0]!, content: 'updated page' }, files[1]!])
})

test('bounded model context preserves assets and large omitted lockfiles through edits', async () => {
  const { selectEditContext } = await import('../../file-edits');
  const { createSourceAsset } = await import('@wrenly/source-control');
  const image = { path: 'public/logo.png', content: '', asset: createSourceAsset('public/logo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPoLYj5DwAFQAJZssNTVgAAAABJRU5ErkJggg==', 'base64')) };
  const lock = { path: 'bun.lock', content: 'x'.repeat(200_000) };
  const source = [...base, image, lock];
  const context=selectEditContext(source,'Change app/page.tsx');
  expect(context.files.some(file => file.path === image.path)).toBe(false);
  expect(context.omitted).toContain('bun.lock');
  expect(JSON.stringify(context.files)).not.toContain(image.asset.base64);
  const changed=applyFileEdits(source,{version:1,operations:[{type:'update',path:'app/page.tsx',content:'New heading'}]});
  expect(changed.find(file=>file.path===image.path)).toEqual(image);
  expect(changed.find(file=>file.path===lock.path)).toEqual(lock);
  expect(() => applyFileEdits(source,{version:1,operations:[{type:'delete',path:image.path}]})).toThrow('binary');
});
