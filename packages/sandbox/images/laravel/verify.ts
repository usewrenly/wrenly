// Trusted offline probe. Generated PHP executes only in the surrounding sandbox.
const runtime = Bun.spawn(['frankenphp', 'run', '--config', '/wrenly/Caddyfile'], { stdout: 'inherit', stderr: 'inherit' })
const deadline = Date.now() + 15_000
try {
  let html: string | undefined
  while (Date.now() < deadline && runtime.exitCode === null) {
    try {
      const response = await fetch('http://127.0.0.1:3000/', { redirect: 'error', signal: AbortSignal.timeout(1000) })
      if (response.ok) { html = await response.text(); break }
    } catch { /* The application server may still be starting. */ }
    await Bun.sleep(100)
  }
  if (!html || html.length > 2 * 1024 * 1024) throw new Error('Laravel root page did not render within the readiness deadline.')
  for (const tag of html.matchAll(/<(?:script|link|img)\b[^>]*>/gi)) {
    const reference = tag[0].match(/(?:src|href)=["']([^"']+)["']/i)?.[1]
    if (reference && new URL(reference, 'http://127.0.0.1:3000/').origin !== 'http://127.0.0.1:3000')
      throw new Error('Laravel assets must not depend on external scripts, fonts or images.')
  }
  const assets = [...html.matchAll(/(?:href|src)=["']([^"']+\.(?:css|js)(?:\?[^"']*)?)["']/g)].map(match => match[1]!)
  if (!assets.some(asset => asset.split('?')[0]!.endsWith('.css'))) throw new Error('Laravel root page must reference a local stylesheet.')
  for (const asset of assets) {
    const url = new URL(asset, 'http://127.0.0.1:3000/')
    if (url.origin !== 'http://127.0.0.1:3000') throw new Error('Laravel assets must be bundled locally, without CDN dependencies.')
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(1000) })
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || type.includes('text/html')) throw new Error('Laravel referenced asset did not load.')
    const body = await response.text()
    if (body.length === 0) throw new Error('Laravel referenced asset is empty.')
    if (url.pathname.endsWith('.css') && /@(tailwind|apply|theme|utility|source|config|plugin)\b|@import\s*(?:url\()?\s*["']tailwindcss(?:["'/])/i.test(body.replace(/\/\*[\s\S]*?\*\//g, '')))
      throw new Error('Laravel served uncompiled Tailwind CSS. Compile utility directives into the final local stylesheet during the offline asset build.')
  }
  console.log('Laravel offline HTTP and local asset validation passed.')
} finally {
  runtime.kill()
  await runtime.exited
}
export {}
