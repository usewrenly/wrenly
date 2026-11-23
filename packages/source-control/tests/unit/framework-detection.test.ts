import { expect, test } from 'bun:test';
import { detectSourceFramework } from '../../src/policy/framework-detection';
const next = { path: 'package.json', content: '{"dependencies":{"next":"^16.4.5"}}' };
const laravel = { path: 'composer.json', content: '{"require":{"laravel/framework":"^12.0"}}' };
test('framework detection uses dependency declarations rather than repository names or language', () => {
  expect(detectSourceFramework([next])).toBe('nextjs');
  expect(detectSourceFramework([laravel, { path: 'package.json', content: '{"devDependencies":{"vite":"^6.0"}}' }])).toBe('laravel');
});
test('ambiguous and missing roots need review rather than guessing a framework', () => {
  expect(() => detectSourceFramework([next, laravel])).toThrow('Both Next.js and Laravel');
  expect(() => detectSourceFramework([{ path: 'apps/web/package.json', content: next.content }])).toThrow('repository root');
  expect(() => detectSourceFramework([{ path: 'package.json', content: '{"name":"nextjs"}' }])).toThrow('No Next.js or Laravel');
});
test('malformed manifests produce fixed errors without source details', () => {
  for (const content of ['private-source-not-json', 'null', '[]']) {
    expect(() => detectSourceFramework([{ path: 'package.json', content }])).toThrow('invalid package.json');
    try { detectSourceFramework([{ path: 'package.json', content }]); } catch (error) {
      expect(String(error)).not.toContain('private-source');
    }
  }
});
