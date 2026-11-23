import { expect, test } from 'bun:test';
import { supportsImportedVersion } from '../../src/revision/framework-versions';
test('ordinary maintained-version constraints are preserved without forcing one spelling', () => {
  for (const version of ['^16','16.x','~15.4','15.5.28','^15.0 || ^16.0']) expect(supportsImportedVersion('nextjs',version)).toBe(true);
  for (const version of ['^12','13.*','^12.0|^13.0','~13.0.1']) expect(supportsImportedVersion('laravel',version)).toBe(true);
  for (const version of ['*','latest','^14.0','>=15','^16.0 || ^17.0','16.x.1','github:team/framework']) expect(supportsImportedVersion('nextjs',version)).toBe(false);
});
