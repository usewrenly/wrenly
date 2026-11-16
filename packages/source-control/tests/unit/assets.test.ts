import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createSourceAsset, materializeSourceFile, REVISION_LIMITS, validateSourceFiles, readGitHubSnapshot, reviewSourceChanges } from '../../src';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPoLYj5DwAFQAJZssNTVgAAAABJRU5ErkJggg==', 'base64');
const asset = createSourceAsset('public/logo.png', png);
const file = { path: 'public/logo.png', content: '', asset };
test('verified immutable bytes survive source validation and unchanged GitHub review', () => {
  expect(Buffer.from(materializeSourceFile(file))).toEqual(png);
  expect(validateSourceFiles([file])).toEqual([file]);
  expect(reviewSourceChanges([file, { path: 'a.ts', content: 'before' }], [file, { path: 'a.ts', content: 'after' }])).toEqual([{ kind: 'update', path: 'a.ts', content: 'after' }]);
  expect(() => reviewSourceChanges([file], [])).toThrow();
});
test('hash, type, length, text substitution and unknown binary formats fail closed', () => {
  for (const changed of [{ ...asset, sha256: 'a'.repeat(64) }, { ...asset, mediaType: 'image/jpeg' }, { ...asset, byteLength: asset.byteLength + 1 }])
    expect(() => materializeSourceFile({ ...file, asset: changed })).toThrow();
  expect(() => materializeSourceFile({ ...file, content: 'not empty' })).toThrow();
  for (const name of ['script.exe','image.gif','fake.png']) expect(() => createSourceAsset(name, Buffer.from('not an asset'))).toThrow();
  expect(() => createSourceAsset('large.png', new Uint8Array(REVISION_LIMITS.assetFileBytes + 1))).toThrow();
});
test('Git blob identity is verified before storing binary bytes, with no UTF-8 replacement', async () => {
  const repository = { provider: 'github' as const, id: '12', owner: 'team', name: 'app', private: true };
  const commitId='a'.repeat(40), treeId='b'.repeat(40);
  const blobId=createHash('sha1').update(`blob ${png.length}\0`).update(png).digest('hex');
  const snapshot=await readGitHubSnapshot({ get: async path => {
    if (path === '/repositories/12') return { id: 12, name: 'app', owner: { login: 'team' }, private: true, disabled: false, archived: false };
    if (path.includes('/git/commits/')) return { sha: commitId, tree: { sha: treeId } };
    if (path.includes('/git/trees/')) return { sha: treeId, truncated: false, tree: [{ path: file.path, type: 'blob', mode: '100644', sha: blobId, size: png.length }] };
    return { sha: blobId, size: png.length, encoding: 'base64', content: png.toString('base64') };
  } }, repository, commitId);
  expect(snapshot.files).toEqual([file]);
});

test('real bundled WOFF fonts retain exact bytes and malformed containers are refused', async () => {
  const bytes = new Uint8Array(await Bun.file(`${__dirname}/../../../../apps/web/app/fonts/GeistVF.woff`).arrayBuffer());
  const font = createSourceAsset('public/fonts/interface.woff', bytes);
  expect(font.mediaType).toBe('font/woff');
  expect(materializeSourceFile({ path:'public/fonts/interface.woff',content:'',asset:font })).toEqual(bytes);
  const broken=Buffer.from(bytes); broken.writeUInt32BE(bytes.length+1,8);
  expect(()=>createSourceAsset('public/fonts/interface.woff',broken)).toThrow();
  const corrupted=Buffer.from(png); corrupted[corrupted.length-1] = corrupted[corrupted.length-1]! ^ 1;
  expect(()=>createSourceAsset('public/logo.png',corrupted)).toThrow();
});

test('configured import budgets reject before accepting a larger snapshot', () => {
  const limits={files:1,fileBytes:1024,totalBytes:1024,assetFileBytes:1024,assetBytes:1024};
  expect(()=>validateSourceFiles([file,{path:'a.ts',content:'small'}],limits)).toThrow('size_limit');
  expect(()=>validateSourceFiles([{path:'a.ts',content:'x'.repeat(1025)}],limits)).toThrow('size_limit');
  expect(validateSourceFiles([file],limits)).toEqual([file]);
});
