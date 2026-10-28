import { expect, test } from 'bun:test'
import { LARAVEL_SKELETON } from '../../agents/laravel-agent/src/skeleton'
import { validateLaravelSource } from '../src/source-policy/laravel-runtime'

test('Laravel source preflight preserves secure install policy and rejects legacy versions', () => {
  expect(() => validateLaravelSource(LARAVEL_SKELETON)).not.toThrow()
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
