// Checks whether Tailwind configuration is present by inspecting source as text.
// Never execute generated configuration in the API process to discover its settings.
import { posix } from 'node:path'

const TAILWIND_CONFIGS = ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.cjs', 'tailwind.config.mjs']
const POSTCSS_CONFIGS = ['postcss.config.js', 'postcss.config.cjs', 'postcss.config.mjs', 'postcss.config.json', '.postcssrc.json']
export class NextjsStylingError extends Error {
  constructor(message: string) { super(message); this.name = 'NextjsStylingError' }
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Checks Tailwind 3 prerequisites which Next.js compilation alone does not require. */
export function validateNextjsStyling(files: Array<{ path: string; content: string }>): void {
  const manifest = files.find(file => file.path === 'package.json')
  if (!manifest) return
  let parsed: unknown
  try { parsed = JSON.parse(manifest.content) } catch { throw new NextjsStylingError('Generated package.json is invalid JSON.') }
  if (!record(parsed)) throw new NextjsStylingError('Generated package.json must be an object.')
  const dependencies = record(parsed.dependencies) ? parsed.dependencies : {}
  const devDependencies = record(parsed.devDependencies) ? parsed.devDependencies : {}
  const version = dependencies.tailwindcss ?? devDependencies.tailwindcss
  if (typeof version !== 'string' || !/^[~^]?3\./.test(version.trim())) return
  const paths = new Set(files.map(file => file.path))
  if (!TAILWIND_CONFIGS.some(name => paths.has(name)))
    throw new NextjsStylingError('Tailwind CSS 3 requires tailwind.config.ts with content paths covering app/, src/ and components/. Add the missing configuration.')
  if (!POSTCSS_CONFIGS.some(name => paths.has(name)) && !record(parsed.postcss))
    throw new NextjsStylingError('Tailwind CSS 3 requires postcss.config.mjs with tailwindcss and autoprefixer plugins. Add the missing configuration.')
  const roots = ['app', 'src/app'].filter(root => paths.has(`${root}/layout.tsx`) || paths.has(`${root}/layout.jsx`))
  if (!roots.length) throw new NextjsStylingError('Tailwind CSS 3 requires an App Router root layout importing its global stylesheet.')
  for (const root of roots) {
    const layout = files.find(file => file.path === `${root}/layout.tsx` || file.path === `${root}/layout.jsx`)
    const imports = Array.from((layout?.content ?? '').matchAll(/\bimport\s*['"]([^'"]+\.css)['"]/g), match => match[1]!)
    const stylesheets = imports.flatMap(name => {
      const candidates = name.startsWith('.') ? [posix.normalize(posix.join(root, name))] :
        name.startsWith('@/') ? [name.slice(2), `src/${name.slice(2)}`] : []
      return files.filter(file => candidates.includes(file.path))
    })
    if (!stylesheets.length)
      throw new NextjsStylingError('Tailwind CSS 3 requires a global stylesheet imported by the App Router root layout. Add the stylesheet and import it.')
    const css = stylesheets.map(file => file.content).join('\n')
    if (!['base', 'components', 'utilities'].every(layer => new RegExp(`@tailwind\\s+${layer}\\s*;`).test(css) ||
      new RegExp(`@import\\s+['"]tailwindcss/${layer}['"]`).test(css)))
      throw new NextjsStylingError('Tailwind CSS 3 global CSS requires @tailwind base; @tailwind components; @tailwind utilities; directives.')
  }
}
