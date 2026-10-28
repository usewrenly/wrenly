import { connectPage } from "../../../../test-support/chrome-page";
// Real ArtifactPane/controllers, fixture-only services.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_PREVIEW_BROWSER === "true" ? describe : describe.skip;
integration("Chrome unified workspace logs", () => {
  test("source/search/follow states, bounded revision races and read-only diagnostics across responsive themes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-logs-browser-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
      throw new Error("Use temporary captures.");
    await mkdir(captures, { recursive: true });
    const css = (
      await Promise.all(
        (
          await Array.fromAsync(
            new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }),
          )
        ).map((file) => readFile(join(web, ".next/static/css", file), "utf8")),
      )
    ).join("\n");
    if (!css) throw new Error("Build web with --webpack first.");
    const a = "101e4567-e89b-42d3-a456-426614174001",
      b = "201e4567-e89b-42d3-a456-426614174002",
      project = "101e4567-e89b-42d3-a456-426614174003";
    let bundle = "",
      mode = "normal",
      posts = 0,
      held = 0;
    let release: (() => void) | undefined;
    let pending: Promise<void> = Promise.resolve();
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "Content-Type": "text/javascript; charset=utf-8" },
          });
        if (url.pathname === "/style.css")
          return new Response(css, {
            headers: { "Content-Type": "text/css; charset=utf-8" },
          });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/report") {
          reports.set(
            url.searchParams.get("case") ?? "",
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/scenario") {
          if (url.searchParams.has("hold")) {
            mode = "hold";
            held = 0;
            pending = new Promise<void>((resolvePending) => {
              release = resolvePending;
            });
          } else if (url.searchParams.has("release")) {
            mode = "normal";
            release?.();
          } else mode = url.searchParams.get("mode") ?? "normal";
          return Response.json({ held });
        }
        if (url.pathname === "/held") return Response.json({ held });
        if (url.pathname.startsWith("/api/") && request.method === "POST") {
          posts++;
          return Response.json(
            { error: "Unexpected operation" },
            { status: 500 },
          );
        }
        const isPreview = url.pathname.endsWith("/preview"),
          isPublishing = url.pathname.endsWith("/deploy");
        if (isPreview || isPublishing) {
          const id = isPreview
            ? url.pathname.split("/")[3]
            : url.searchParams.get("buildId");
          if (id === a && mode === "hold") {
            held++;
            await pending;
          }
          const prefix = id === a ? "A" : "B";
          if (id === b && mode === "error")
            return Response.json(
              {
                error: `Fixture ${isPreview ? "preview" : "publishing"} read failed`,
              },
              { status: 503 },
            );
          const disabled = id === b && mode === "disabled";
          return isPreview
            ? Response.json({
                enabled: !disabled,
                supported: true,
                activePreview: null,
                preview: disabled
                  ? null
                  : {
                      id: `${prefix}-preview-operation`,
                      buildId: id,
                      status: "preparing",
                      log: `${prefix}_ONLY_PREVIEW\nPreparing isolated runtime`,
                      error: null,
                      cleanupPending: false,
                    },
              })
            : Response.json({
                enabled: !disabled,
                deployment: disabled
                  ? null
                  : {
                      id: `${prefix}-publish-operation`,
                      buildId: id,
                      status: "preparing",
                      errorCode: null,
                      url: null,
                    },
              });
        }
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>@font-face{font-family:Fixture;src:url(/font.woff);font-weight:100 900}:root{--font-geist-sans:Fixture;--font-geist-mono:monospace}#root{height:100dvh;display:flex;flex-direction:column;overflow:hidden}.fixture-controls{display:flex;gap:12px;flex-wrap:wrap;padding:12px;border-bottom:1px solid var(--color-border)}.fixture-controls button{font-size:12px}</style><div id="root"></div><script type="module" src="/bundle.js"></script>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    let debugging: Awaited<ReturnType<typeof connectPage>> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        config = join(directory, "tsconfig.json"),
        output = join(directory, "bundle.js");
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: { jsx: "react-jsx", paths: { "@/*": [web + "/*"] } },
        }),
      );
      await writeFile(
        entry,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {ArtifactPane} from ${JSON.stringify(join(web, "components/workspace/artifacts/artifact-pane.tsx"))};
const scenario=new URLSearchParams(location.search).get('case');document.documentElement.dataset.theme=scenario.includes('dark')?'dark':'light';const a=${JSON.stringify(a)},b=${JSON.stringify(b)};
function App(){const [id,setId]=React.useState(a),[grown,setGrown]=React.useState(false);const state={buildId:id,phase:{name:'success',attempt:1,buildLog:''},logs:id===a?Array.from({length:grown?240:180},(_,i)=>i===12?'A_ONLY_BUILD error needle':'A_ONLY_BUILD line '+i):['B_ONLY_BUILD','Validation completed'],files:null,streamed:false};return React.createElement(React.Fragment,null,React.createElement('div',{className:'fixture-controls'},React.createElement('button',{id:'grow',onClick:()=>setGrown(true)},'Fixture: append'),React.createElement('button',{id:'revision-b',onClick:()=>setId(b)},'Fixture: revision B'),React.createElement('button',{id:'no-revision',onClick:()=>setId(undefined)},'Fixture: no revision')),React.createElement('div',{style:{flex:1,minHeight:0}},React.createElement(ArtifactPane,{projectId:${JSON.stringify(project)},state,liveUrl:null,onDeployed:()=>{},tab:'logs'})))}
createRoot(document.getElementById('root')).render(React.createElement(App));const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label)=>{for(let i=0;i<900;i++){if(await check())return;await sleep(10)}throw Error('Logs timeout: '+label)};const choose=text=>Array.from(document.querySelectorAll('.workspace-log-filters button')).find(node=>node.getAttribute('aria-label')===text).click();const text=()=>document.querySelector('.workspace-logs')?.textContent||'';const source=id=>document.querySelector('[data-log-source="'+id+'"]');const fill=value=>{const node=document.querySelector('[aria-label="Search diagnostic output"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}))};
(async()=>{try{
 await until(()=>document.querySelector('.workspace-log-filters button'),'log controls');choose('All sources');await until(()=>text().includes('A_ONLY_PREVIEW')&&text().includes('A-publis'),'all source readiness');await document.fonts.ready;
 if(innerWidth!==Number(new URLSearchParams(location.search).get('width')))throw Error('Wrong fixture viewport');if(document.documentElement.scrollWidth>innerWidth)throw Error('Diagnostics overflow');choose('Build');await until(()=>document.querySelectorAll('[data-log-source]').length===1,'build filter');
 const output=document.querySelector('.workspace-log-output');await until(()=>output.scrollHeight>output.clientHeight+100,'scrollable log');output.scrollTop=0;output.dispatchEvent(new Event('scroll',{bubbles:true}));await until(()=>document.querySelector('.workspace-log-meta button').textContent==='Follow latest','pause follow');document.querySelector('#grow').click();await until(()=>source('build')?.textContent.includes('line 239'),'appended log');await sleep(60);if(output.scrollTop>1)throw Error('Append stole paused reading');fill('ERROR NEEDLE');await until(()=>source('build')?.querySelector('pre')?.textContent==='A_ONLY_BUILD error needle','paused search');await sleep(60);if(document.querySelector('.workspace-log-meta button').textContent!=='Follow latest')throw Error('Search silently resumed paused following');fill('');await until(()=>source('build')?.textContent.includes('line 239'),'paused search cleared');document.querySelector('.workspace-log-meta button').click();await until(()=>output.scrollTop>100,'resume follow');
 fill('ERROR NEEDLE');await until(()=>source('build')?.querySelector('pre')?.textContent==='A_ONLY_BUILD error needle','plain search');if(!text().includes('1 matching diagnostic lines'))throw Error('Wrong search count');fill('absent');await until(()=>text().includes('No diagnostic lines match'),'no matches');document.querySelector('.workspace-log-clear').click();await until(()=>source('build')?.textContent.includes('line 239'),'clear restores source');choose('Preview');await until(()=>source('preview')&&!source('build'),'preview filter');choose('Publishing');await until(()=>source('publishing')&&!source('preview'),'publishing filter');if(!text().includes('Status only')||!text().includes('Raw deployment runtime logs'))throw Error('Publishing implies nonexistent logs');
 await fetch('/scenario?hold');await until(async()=>{const value=await(await fetch('/held')).json();return value.held>=2},'held old revision responses');document.querySelector('#revision-b').click();await until(()=>text().includes(${JSON.stringify(b.slice(0, 8))})&&text().includes('B_ONLY_BUILD'),'revision reset');if(text().includes('A_ONLY'))throw Error('Old output survived revision switch');choose('All sources');await until(()=>text().includes('B_ONLY_PREVIEW'),'new preview');await fetch('/scenario?release');await sleep(80);if(text().includes('A_ONLY'))throw Error('Late old response leaked into selected revision');
 await fetch('/scenario?mode=error');await until(()=>text().includes('Fixture preview read failed')&&text().includes('Fixture publishing read failed'),'independent read errors');if(!text().includes('B_ONLY_BUILD')||text().includes('B_ONLY_PREVIEW'))throw Error('Failed source hid build or showed stale output');await fetch('/scenario?mode=disabled');await until(()=>text().includes('Local previews are disabled')&&text().includes('Publishing is disabled'),'disabled sources');await fetch('/scenario');await until(()=>text().includes('B_ONLY_PREVIEW'),'recovered snapshot');
 document.querySelector('#no-revision').click();await until(()=>document.body.textContent.includes('Select a revision to inspect'),'no selected revision');document.querySelector('#revision-b').click();await until(()=>document.querySelector('.workspace-log-filters button'),'restored controls');choose('All sources');await until(()=>text().includes('B_ONLY_PREVIEW'),'restored selection');choose('Build');await sleep(30);document.querySelector('.workspace-log-output').scrollTop=0;
 await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/scenario?release');await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({error:error.stack ?? error.message})})}})();`,
      );
      const built = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "build",
          entry,
          "--target=browser",
          "--define",
          'process.env.NODE_ENV="production"',
          "--define",
          "process.env.NEXT_PUBLIC_DOCS_URL=undefined",
          "--tsconfig-override",
          config,
          "--outfile",
          output,
        ],
        { cwd: web, stdout: "pipe", stderr: "pipe" },
      );
      const [code, diagnostic] = await Promise.all([
        built.exited,
        new Response(built.stderr).text(),
      ]);
      if (code) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const [name, width] of [
        ["logs-desktop", 1440],
        ["logs-mobile", 390],
        ["logs-small", 320],
        ["logs-dark", 1440],
      ] as const) {
        mode = "normal";
        held = 0;
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--hide-scrollbars",
            "--remote-debugging-port=0",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${width},1000`,

            "about:blank",
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        debugging = await connectPage(join(directory, name));
        await debugging.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 1000,
          deviceScaleFactor: 1,
          mobile: false,
        });
        await debugging.send("Page.navigate", {
          url: `${server.url.origin}/?case=${name}&width=${width}`,
        });
        const deadline = Date.now() + 30_000;
        while (!reports.has(name) && Date.now() < deadline) await Bun.sleep(20);
        expect(reports.get(name)?.error).toBeUndefined();
        expect(reports.get(name)?.ok).toBe(true);
        const capture = await debugging.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        if (
          !capture ||
          typeof capture !== "object" ||
          !("data" in capture) ||
          typeof capture.data !== "string"
        )
          throw new Error("Invalid capture response.");
        await writeFile(
          join(captures, name + ".png"),
          Buffer.from(capture.data, "base64"),
        );
        debugging.close();
        debugging = undefined;
        chrome.kill();
        await chrome.exited;
        chrome = undefined;
      }
      expect(posts).toBe(0);
    } finally {
      release?.();
      debugging?.close();
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});

/** Real timing supports held responses; explicit metrics avoid Chrome's minimum window width. */
