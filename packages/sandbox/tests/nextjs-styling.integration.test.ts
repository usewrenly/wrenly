// Trusted fixture code executes only inside the existing isolated Docker sandbox.
import { describe, expect, test } from 'bun:test'
import { runSandbox } from '../src/index'
const integration = process.env.WRENLY_TEST_DOCKER === 'true' ? describe : describe.skip
integration('Tailwind compiled output', () => {
  test('PostCSS generates real layout and typography utilities during offline validation', async () => {
    const result = await runSandbox({ projectId: crypto.randomUUID(), stack: 'nextjs', files: [
      { path: 'package.json', content: JSON.stringify({ name: 'tailwind-fixture', scripts: { build: 'bun run verify.ts' },
        devDependencies: { tailwindcss: '3.4.19', postcss: '8.5.30', autoprefixer: '10.6.1' } }) },
      { path: 'tailwind.config.ts', content: 'export default { content: ["./app/**/*.{ts,tsx}"], theme: { extend: {} }, plugins: [] }' },
      { path: 'postcss.config.mjs', content: 'export default { plugins: { tailwindcss: {}, autoprefixer: {} } }' },
      { path: 'app/layout.tsx', content: 'import "./globals.css"; export default function Layout({children}) { return <html><body>{children}</body></html> }' },
      { path: 'app/globals.css', content: '@tailwind base; @tailwind components; @tailwind utilities;' },
      { path: 'app/page.tsx', content: 'export default function Page() { return <main className="p-8 text-3xl">Styled</main> }' },
      { path: 'verify.ts', content: `import postcss from 'postcss'; import tailwindcss from 'tailwindcss'; import autoprefixer from 'autoprefixer';
        const css = await Bun.file('app/globals.css').text();
        const compiled = await postcss([tailwindcss(), autoprefixer()]).process(css, { from: 'app/globals.css' });
        if (!compiled.css.includes('.p-8') || !compiled.css.includes('padding: 2rem') ||
          !compiled.css.includes('.text-3xl') || !compiled.css.includes('font-size: 1.875rem')) throw Error('Tailwind utility output missing');
        console.log('TAILWIND_LAYOUT_AND_TYPOGRAPHY_COMPILED');` },
    ] })
    expect(result.success).toBe(true)
    expect(result.output).toContain('TAILWIND_LAYOUT_AND_TYPOGRAPHY_COMPILED')
  }, 120_000)
})
