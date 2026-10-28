import { expect, test } from 'bun:test'
import { validateNextjsStyling } from '../../src/source-policy/nextjs-styling'
import { runSandbox } from '../../src/index'
const files = [
  { path: 'package.json', content: JSON.stringify({ devDependencies: { tailwindcss: '^3.4.0' } }) },
  { path: 'tailwind.config.ts', content: 'export default { content: ["./app/**/*.tsx"] }' },
  { path: 'postcss.config.mjs', content: 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } }' },
  { path: 'app/layout.tsx', content: "import './globals.css'; export default function Layout() {}" },
  { path: 'app/globals.css', content: '@tailwind base; @tailwind components; @tailwind utilities;' },
]
test('accepts configured Tailwind 3 in app and src/app without executing config', () => {
  expect(() => validateNextjsStyling(files)).not.toThrow()
  expect(() => validateNextjsStyling(files.map(file => ({ ...file, path: file.path.startsWith('app/') ? `src/${file.path}` : file.path })))).not.toThrow()
})
test('catches missing Tailwind and PostCSS config even though Next.js can compile', () => {
  for (const [path, message] of [['tailwind.config.ts', 'tailwind.config'], ['postcss.config.mjs', 'postcss.config']])
    expect(() => validateNextjsStyling(files.filter(file => file.path !== path))).toThrow(message)
})
test('catches absent stylesheet wiring and missing Tailwind directives', () => {
  expect(() => validateNextjsStyling(files.filter(file => file.path !== 'app/globals.css'))).toThrow('stylesheet')
  expect(() => validateNextjsStyling(files.map(file => file.path === 'app/layout.tsx' ? { ...file, content: '' } : file))).toThrow('import')
  expect(() => validateNextjsStyling(files.map(file => file.path === 'app/globals.css' ? { ...file, content: 'body { color: red }' } : file))).toThrow('directives')
})
test('does not impose Tailwind configuration on plain CSS or other Tailwind majors', () => {
  expect(() => validateNextjsStyling([{ path: 'package.json', content: '{}' }])).not.toThrow()
  expect(() => validateNextjsStyling([{ path: 'package.json', content: '{"dependencies":{"tailwindcss":"^4.0.0"}}' }])).not.toThrow()
})
test('sandbox returns actionable preflight feedback before installing or compiling', async () => {
  const result = await runSandbox({ projectId: crypto.randomUUID(), stack: 'nextjs', files: files.filter(file => file.path !== 'postcss.config.mjs') })
  expect(result.success).toBe(false)
  expect(result.error).toContain('postcss.config.mjs')
  expect(result.output).toBe('')
})
test('accepts relative stylesheet locations and supported alias imports', () => {
  const alternate = files.map(file => file.path === 'app/globals.css' ? { ...file, path: 'styles/base.css' } :
    file.path === 'app/layout.tsx' ? { ...file, content: 'import "../styles/base.css";' } : file)
  expect(() => validateNextjsStyling(alternate)).not.toThrow()
  expect(() => validateNextjsStyling(alternate.map(file => file.path === 'app/layout.tsx' ? { ...file, content: 'import "@/styles/base.css";' } : file))).not.toThrow()
})
