import { expect, test } from 'bun:test';
import { validateApplicationRoot, repositorySourcePath, readGitHubSourceTree } from '../../src';
const sha = 'a'.repeat(40);
test('application roots remain relative and reject private or escaping selections', () => {
  for (const root of ['', 'apps/web', 'services/customer portal']) expect(validateApplicationRoot(root)).toBe(root);
  for (const root of ['/apps/web', '../web', 'apps/../web', 'apps/web/', '.git', 'vendor/package', 'node_modules/app'])
    expect(() => validateApplicationRoot(root)).toThrow();
  expect(repositorySourcePath('apps/web', 'app/page.tsx')).toBe('apps/web/app/page.tsx');
  expect(() => repositorySourcePath('apps/web', '../sibling.ts')).toThrow();
});
test('selected roots apply budgets to that app and never import siblings or private environments', () => {
  const blob = (path: string, size = 1) => ({ path, size, sha, mode: '100644', type: 'blob' });
  const result = readGitHubSourceTree({ sha, truncated: false, tree: [
    blob('apps/web/package.json'), blob('apps/web/.env'), blob('apps/website/package.json'),
    blob('apps/other/huge.png', 20 * 1024 * 1024),
  ] }, sha, 'apps/web');
  expect(result.entries.map(entry => entry.path)).toEqual(['package.json']);
  expect(result.excludedPaths).toEqual(['.env']);
  expect(() => readGitHubSourceTree({ sha, truncated: false, tree: [blob('apps/web/../escape.ts')] }, sha, 'apps/web')).toThrow();
});
