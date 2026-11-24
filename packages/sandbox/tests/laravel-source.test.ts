import { expect, test } from 'bun:test'
import { LARAVEL_SKELETON } from '../../agents/laravel-agent/src/skeleton'
import { validateLaravelSource } from '../src/source-policy/laravel-runtime'

test('Laravel source preflight preserves secure install policy and rejects legacy versions', () => {
  expect(() => validateLaravelSource(LARAVEL_SKELETON)).not.toThrow()
  expect(LARAVEL_SKELETON.some(file => file.path === 'config/database.php')).toBe(true)
  expect(LARAVEL_SKELETON.some(file => file.path === 'config/auth.php')).toBe(true)
  const manifest = JSON.parse(LARAVEL_SKELETON[0]!.content) as Record<string, unknown>
  for (const patch of [
    { require: { 'laravel/framework': '^11.0' } }, { scripts: { 'post-install-cmd': 'php malicious.php' } },
    { repositories: [{ type: 'composer', url: 'https://other.invalid' }] },
    { config: { policy: { advisories: { block: false } } } },
    { config: { audit: { ignore: ['unsafe'] } } }, { config: { 'allow-plugins': true } },
  ]) expect(() => validateLaravelSource(LARAVEL_SKELETON.map(file => file.path === 'composer.json' ?
    { ...file, content: JSON.stringify({ ...manifest, ...patch }) } : file))).toThrow()
  for (const path of ['.env', 'vendor/autoload.php', 'bootstrap/cache/config.php', 'storage/logs/laravel.log', '.npmrc', 'bunfig.toml'])
    expect(() => validateLaravelSource([...LARAVEL_SKELETON, { path, content: 'untrusted' }])).toThrow()
  expect(() => validateLaravelSource(LARAVEL_SKELETON.map(file => file.path === '.env.example' ? { ...file, content: 'APP_KEY=base64:placeholder' } : file))).toThrow()
  expect(() => validateLaravelSource([...LARAVEL_SKELETON, { path: 'resources/views/unicode.blade.php', content: 'Équipe — مرحبا' }])).not.toThrow()
})


test('Laravel refuses browser-served Tailwind instructions without an offline asset build', () => {
  for (const content of ['@tailwind utilities;', '@import "tailwindcss";', '.button { @apply px-4; }']) {
    expect(() => validateLaravelSource([...LARAVEL_SKELETON, { path: 'public/utility-input.css', content }])).toThrow('uncompiled Tailwind');
  }
  expect(() => validateLaravelSource([...LARAVEL_SKELETON, { path: 'public/utility-input.css', content: '/* @tailwind is compiled separately */ .button { padding: 1rem; }' }])).not.toThrow();
})

for (const version of ['^12.0', '~12.1.0', '12.1.0', '^13.0']) {
  test(`Laravel source preserves compatible requirement ${version}`, () => {
    const files = LARAVEL_SKELETON.map(file => file.path === 'composer.json' ?
      { ...file, content: JSON.stringify({ ...JSON.parse(file.content), require: { php: '^8.4', 'laravel/framework': version } }) } : file);
    expect(() => validateLaravelSource(files)).not.toThrow();
    expect(JSON.parse(files[0]!.content).require['laravel/framework']).toBe(version);
  });
}
