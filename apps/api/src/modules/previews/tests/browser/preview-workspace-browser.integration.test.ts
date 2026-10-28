// Actual workspace component race check, using controlled API responses and Chrome.
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
const integration = process.env.WRENLY_TEST_PREVIEW_BROWSER === 'true' ? describe : describe.skip
integration('Chrome revision-aware preview pane', () => {
  test('renders the selected revision and discards late history responses, stops the frame and retains code', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wrenly-preview-workspace-'))
    const a = crypto.randomUUID(); const b = crypto.randomUUID(); const pa = crypto.randomUUID(); const pb = crypto.randomUUID()
    let result: { ok?: boolean; error?: string } | undefined
    let delayed = true
    let stopped = false
    let bundle = ''
    const server: ReturnType<typeof Bun.serve> = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname === '/bundle.js') return new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
      if (url.pathname === '/report') { result = await request.json() as typeof result; return new Response('ok') }
      if (url.pathname === `/api/builds/${a}/preview` || url.pathname === `/api/builds/${b}/preview`) {
        const isA = url.pathname.includes(a)
        return Response.json({ enabled: true, supported: true, activePreview: null, preview: { id: isA ? pa : pb, buildId: isA ? a : b, status: !isA && stopped ? 'stopped' : 'ready', log: '', error: null, cleanupPending: false } })
      }
      if (url.pathname === `/api/previews/${pb}/stop`) { stopped = true; return Response.json({stopped:true}) }
      if (url.pathname === `/api/previews/${pa}/access`) { if (delayed) { delayed = false; await Bun.sleep(500) }; return Response.json({ url: `http://${pa}.wrenly-preview.localhost:${server.port}/frame/A` }) }
      if (url.pathname === `/api/previews/${pb}/access`) return Response.json({ url: `http://${pb}.wrenly-preview.localhost:${server.port}/frame/B` })
      if (url.pathname.startsWith('/frame/')) return new Response(`<p>${url.pathname}</p>`, { headers: { 'content-type': 'text/html' } })
      return new Response('<div id="root"></div><script src="/bundle.js"></script>', { headers: { 'content-type': 'text/html' } })
    } })
    const origin = `http://localhost:${server.port}`
    const fixture = `import React from ${JSON.stringify(resolve(import.meta.dir, '../../../../../../web/node_modules/react/index.js'))};import {createRoot} from ${JSON.stringify(resolve(import.meta.dir, '../../../../../../web/node_modules/react-dom/client.js'))};import {ArtifactPane} from ${JSON.stringify(resolve(import.meta.dir, '../../../../../../web/components/workspace/artifacts/artifact-pane.tsx'))};
      function App(){const[build,setBuild]=React.useState(${JSON.stringify(a)});const[validated,setValidated]=React.useState(true);React.useEffect(()=>{(async()=>{const sleep=ms=>new Promise(r=>setTimeout(r,ms));const until=async check=>{for(let n=0;n<200;n++){if(check())return;await sleep(10)}throw Error('workspace timed out')};try{await sleep(100);setBuild(${JSON.stringify(b)});await until(()=>document.querySelector('iframe')?.src.includes('/frame/B'));await sleep(700);if(!document.querySelector('iframe')?.src.includes('/frame/B'))throw Error('late A replaced B');setValidated(false);await until(()=>!document.querySelector('iframe'));setValidated(true);await until(()=>document.querySelector('iframe')?.src.includes('/frame/B'));[...document.querySelectorAll('button')].find(button=>button.textContent==='Stop preview').click();await until(()=>!document.querySelector('iframe'));[...document.querySelectorAll('button')].find(button=>button.textContent.startsWith('Code')).click();await until(()=>document.body.textContent.includes('source retained'));await fetch('/report',{method:'POST',body:JSON.stringify({ok:true})})}catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({error:e.message})})}})()},[]);return React.createElement(ArtifactPane,{state:{buildId:build,phase:validated?{name:'success',attempt:1,buildLog:''}:{name:'failed',attempt:1,error:'Fixture validation changed'},files:[{path:'fixture.ts',content:'source retained'}],logs:[],streamed:true},projectId:'project',liveUrl:null,onDeployed:()=>{}})}createRoot(document.getElementById('root')).render(React.createElement(App));`
    const entry = join(directory, 'fixture.ts')
    await writeFile(entry, fixture)
    const web = resolve(import.meta.dir, '../../../../../../web')
    const configuration = join(directory, 'tsconfig.json')
    const outputPath = join(directory, 'bundle.js')
    await writeFile(configuration, JSON.stringify({ compilerOptions: { jsx: 'react-jsx', paths: {
      '@/*': [web + '/*'], react: [web + '/node_modules/react'], 'react/*': [web + '/node_modules/react/*'],
    } } }))
    // Use the same CLI browser-resolution path as the other component fixtures.
    const builder = Bun.spawn([process.execPath, '--no-env-file', 'build', entry, '--target=browser',
      '--define', 'process.env.NODE_ENV="production"', '--define', 'process.env.NEXT_PUBLIC_DOCS_URL=undefined',
      '--tsconfig-override', configuration, '--outfile', outputPath], { cwd: web, stdout: 'ignore', stderr: 'pipe' })
    const [status, diagnostics] = await Promise.all([builder.exited, new Response(builder.stderr).text()])
    if (status !== 0) { await server.stop(true); await rm(directory, { recursive: true, force: true }); throw new Error('Workspace fixture bundle failed: ' + diagnostics) }
    bundle = await Bun.file(outputPath).text()
    const chrome = Bun.spawn([process.env.WRENLY_TEST_CHROME_PATH ?? '/usr/bin/google-chrome', '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', `--user-data-dir=${join(directory, 'profile')}`, origin], { stdout: 'ignore', stderr: 'ignore' })
    try {
      const deadline = Date.now() + 15_000
      while (!result && Date.now() < deadline) await Bun.sleep(20)
      expect(result?.error).toBeUndefined(); expect(result?.ok).toBe(true)
    } finally { chrome.kill(); await chrome.exited; await server.stop(true); await rm(directory, { recursive: true, force: true }) }
  }, 25_000)
})
