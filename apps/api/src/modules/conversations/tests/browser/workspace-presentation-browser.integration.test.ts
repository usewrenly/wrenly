// Styled real workspace; fixture services only.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const integration =
  process.env.WRENLY_TEST_PREVIEW_BROWSER === "true" ? describe : describe.skip;
integration("Chrome workspace presentation", () => {
  test("responsive views, draft preservation, keyboard resize, stable tabs and file paths without admission", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wrenly-workspace-style-"));
    const web = resolve(import.meta.dir, "../../../../../../web");
    const css = (
      await Promise.all(
        (
          await Array.fromAsync(
            new Bun.Glob("*.css").scan({ cwd: join(web, ".next/static/css") }),
          )
        ).map((file) => readFile(join(web, ".next/static/css", file), "utf8")),
      )
    ).join("\n");
    const captures = process.env.WRENLY_TEST_ENTRY_SCREENSHOTS
      ? resolve(process.env.WRENLY_TEST_ENTRY_SCREENSHOTS)
      : directory;
    if (captures !== directory && !captures.startsWith("/tmp/"))
      throw new Error("Use /tmp for captures");
    await mkdir(captures, { recursive: true });
    const project = crypto.randomUUID(),
      build = crypto.randomUUID(),
      conversation = crypto.randomUUID(),
      turn = crypto.randomUUID(),
      stamp = new Date().toISOString();
    let bundle = "",
      changed = false,
      databasesEnabled = false,
      admissions = 0;
    let publishingMode: "none" | "success" | "interrupted" = "none";
    let previewMode:
      "disabled" | "ready" | "interrupted" | "preparing" | "stopped" =
      "disabled";
    let messageOwner = "fixture-owner";
    const promptRequests: Array<Record<string, unknown>> = [];
    const previewId = crypto.randomUUID();
    const mediaRevision = crypto.randomUUID();
    const reports = new Map<string, { ok?: boolean; error?: string }>();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === "/bundle.js")
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        if (url.pathname === "/style.css")
          return new Response(css, { headers: { "content-type": "text/css" } });
        if (url.pathname === "/font.woff")
          return new Response(Bun.file(join(web, "app/fonts/GeistVF.woff")));
        if (url.pathname === "/report") {
          reports.set(
            url.searchParams.get("case")!,
            (await request.json()) as { ok?: boolean; error?: string },
          );
          return new Response("ok");
        }
        if (url.pathname === "/change") {
          changed = true;
          return new Response("ok");
        }
        if (
          url.pathname === `/api/previews/${previewId}/access` &&
          request.method === "POST"
        )
          return Response.json({
            url: `http://fixture.wrenly-preview.localhost:${server.port}/frame`,
          });
        if (url.pathname === "/frame")
          return new Response(
            '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:40px;background:#fafaf7;color:#272b20;font:14px system-ui}nav{display:flex;justify-content:space-between;border-bottom:1px solid #ddd;padding-bottom:24px}main{padding:80px 0}small{letter-spacing:.15em}h1{font:52px/1.1 Georgia,serif;max-width:550px;letter-spacing:-.04em}p{color:#6e6b64;line-height:1.8}footer{border-top:1px solid #ddd;padding-top:24px;font-size:11px}@media(max-width:500px){body{padding:24px}main{padding:40px 0}h1{font-size:38px}}</style><nav><strong>Fieldwork</strong><span>Our approach</span></nav><main><small>A LITTLE SPACE FOR BETTER WORK</small><h1>Good ideas deserve room to grow.</h1><p>A considered workspace for independent minds. Less noise, more possibility.</p></main><footer>Illustrative app fixture · not generated output</footer>',
            { headers: { "content-type": "text/html; charset=utf-8" } },
          );
        if (request.method === "POST" && url.pathname.endsWith("/messages")) {
          promptRequests.push(
            (await request.json()) as Record<string, unknown>,
          );
          return Response.json(
            { turnId: crypto.randomUUID() },
            { status: 202 },
          );
        }
        if (request.method === "POST") {
          admissions++;
          return Response.json(
            { error: "Unexpected admission" },
            { status: 500 },
          );
        }
        if (url.pathname === "/api/auth/get-session")
          return Response.json({
            user: {
              id: "fixture-owner",
              name: "James Kamwendo",
              email: "owner@example.test",
            },
            session: {
              id: "fixture",
              expiresAt: new Date(Date.now() + 60000).toISOString(),
            },
          });
        if (url.pathname === "/api/models")
          return Response.json({
            envDefault: "fixture-model-with-a-long-name-and-version-2026-10-18",
            defaultProvider: "fixture",
            models: [
              {
                id: "fixture-model-with-a-long-name-and-version-2026-10-18",
                label:
                  "Local model with an intentionally long descriptive name that must fit the narrow conversation composer",
                provider: "fixture",
                kind: "local",
              },
            ],
            providers: [
              {
                id: "fixture-model-with-a-long-name-and-version-2026-10-18",
                label:
                  "Local model with an intentionally long descriptive name that must fit the narrow conversation composer",
                kind: "local",
                reachable: true,
                displayUrl: "fixture.invalid",
                hint: null,
              },
            ],
          });
        if (url.pathname === `/api/projects/${project}/databases`) return Response.json({
          capabilities: { manage: true, developmentRows: true, productionRows: true }, resources: [{
            id: "00000000-0000-4000-8000-000000000081", projectId: project, environment: "development", provider: "local", status: "ready",
            revision: "00000000-0000-4000-8000-000000000082", schemaDigest: "a".repeat(64), errorCode: null, createdAt: stamp, updatedAt: stamp }], operations: [] });
        if (url.pathname === `/api/projects/${project}`)
          return Response.json({
            features: { developmentDatabases: databasesEnabled },
            project: {
              id: project,
              name: "Fieldwork — a considered workspace",
              stack: "nextjs",
            },
            builds: [
              {
                id: build,
                prompt: "Create a considered workspace",
                status: changed ? "failed" : "success",
                attemptCount: 1,
                files: changed
                  ? [
                      {
                        path: "app/globals.css",
                        content: "body { color: olive; }",
                      },
                      {
                        path: "app/page.tsx",
                        content:
                          "export default function Page() { return <main>Room for your next idea</main> }",
                      },
                    ]
                  : [
                      {
                        path: "app/page.tsx",
                        content:
                          "export default function Page() { return <main>Room for your next idea</main> }",
                      },
                      {
                        path: "app/globals.css",
                        content: "body { color: olive; }",
                      },
                    ],
                buildLog: "Validation fixture output",
                errorMessage: changed ? "Fixture validation failed" : null,
                deployedUrl: null,
                createdAt: stamp,
              },
            ],
          });
        if (url.pathname === `/api/builds/${build}/activity`)
          return Response.json({
            buildId: build,
            cursor: 4,
            activity: [
              {
                sequence: 1,
                attempt: 1,
                operation: "generation",
                state: "completed",
                occurredAt: stamp,
              },
              {
                sequence: 2,
                attempt: 1,
                operation: "validation",
                state: "failed",
                occurredAt: stamp,
              },
              {
                sequence: 3,
                attempt: 2,
                operation: "generation",
                state: "started",
                occurredAt: stamp,
              },
            ],
          });
        if (url.pathname.endsWith("/messages"))
          return Response.json({
            conversationId: conversation,
            messages:
              Number(url.searchParams.get("after")) > 0
                ? []
                : [
                    {
                      id: crypto.randomUUID(),
                      turnId: turn,
                      sequence: 1,
                      role: "user",
                      author: {
                        id: messageOwner,
                        name: "Prompt author",
                        pictureUrl: null,
                      },
                      content:
                        "Make the introduction quieter, with an olive accent.",
                      kind: "message",
                      createdAt: stamp,
                    },
                    {
                      id: crypto.randomUUID(),
                      turnId: turn,
                      sequence: 2,
                      role: "assistant",
                      content:
                        "I simplified the introduction and preserved the page structure.\n\n- A clearer headline\n- More room around the introduction\n- A consistent olive accent",
                      kind: "answer",
                      createdAt: stamp,
                    },
                  ],
            turns: [
              {
                id: turn,
                mode: "auto",
                status: "completed",
                baseBuildId: null,
                buildId: build,
                errorMessage: null,
                model: "fixture",
                provider: "fixture",
              },
            ],
            latestTurn: null,
            nextCursor: null,
          });
        if (url.pathname === `/api/projects/${project}/preview-media`)
          return Response.json({
            revision: mediaRevision,
            origins: [
              "https://images.unsplash.com",
              "https://images.pexels.com",
              "https://videos.pexels.com",
            ],
            availableOrigins: [
              "https://images.unsplash.com",
              "https://images.pexels.com",
              "https://videos.pexels.com",
            ],
            canManage: true,
          });
        if (url.pathname.endsWith("/preview"))
          return Response.json({
            enabled: previewMode !== "disabled",
            supported: true,
            preview:
              previewMode === "disabled"
                ? null
                : {
                    id: previewId,
                    buildId: build,
                    status: previewMode,
                    log: "Fixture preview preparation output",
                    error:
                      previewMode === "interrupted"
                        ? "Preview execution was interrupted."
                        : null,
                    cleanupPending: false,
                  },
            activePreview: null,
          });
        if (url.pathname.endsWith("/deploy"))
          return Response.json({
            enabled: true,
            deployment:
              publishingMode === "none"
                ? null
                : {
                    id: previewId,
                    buildId: build,
                    status: publishingMode,
                    url:
                      publishingMode === "success"
                        ? "https://published.fixture.test"
                        : null,
                    errorCode: null,
                  },
          });
        return new Response(
          `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><style>@font-face{font-family:Fixture;src:url('/font.woff');font-weight:100 900}:root{--font-geist-sans:Fixture;--font-geist-mono:monospace}body{font-family:Fixture}#root{height:100dvh;overflow:hidden}</style><div id="root"></div><script type="module" src="/bundle.js"></script>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    });
    let chrome: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const entry = join(directory, "fixture.tsx"),
        config = join(directory, "tsconfig.json"),
        link = join(directory, "link.tsx");
      await writeFile(
        link,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};export default function Link(props){return React.createElement('a',props)}`,
      );
      await writeFile(
        config,
        JSON.stringify({
          compilerOptions: {
            jsx: "react-jsx",
            paths: {
              "@/*": [web + "/*"],
              "next/link": [link],
              "@tanstack/react-query": [
                Bun.resolveSync("@tanstack/react-query", web),
              ],
            },
          },
        }),
      );
      await writeFile(
        entry,
        `import React from ${JSON.stringify(join(web, "node_modules/react/index.js"))};import {createRoot} from ${JSON.stringify(join(web, "node_modules/react-dom/client.js"))};import {QueryClient,QueryClientProvider} from ${JSON.stringify(Bun.resolveSync("@tanstack/react-query", web))};import {Workspace} from ${JSON.stringify(join(web, "components/workspace/workspace.tsx"))};
      const scenario=new URLSearchParams(location.search).get('case');document.documentElement.setAttribute('data-theme',scenario.includes('dark')?'dark':'light');const client=new QueryClient({defaultOptions:{queries:{retry:false}}});createRoot(document.getElementById('root')).render(React.createElement(QueryClientProvider,{client},React.createElement(Workspace,{projectId:${JSON.stringify(project)}})));
      const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));const until=async(check,label)=>{for(let i=0;i<600;i++){if(check())return;await sleep(10)}throw Error('Timeout '+label+' '+(document.querySelector('textarea')?.value||'')+' '+(document.querySelector('[role=dialog]')?.outerHTML.slice(0,800)||''))};
      (async()=>{try{await until(()=>document.querySelector('textarea')&&!document.querySelector('textarea').disabled,'ready');await document.fonts.ready;
      if(document.documentElement.scrollWidth>innerWidth)throw Error('Document overflow');for(const button of document.querySelectorAll('.workspace-artifact-tabs button,.workspace-mobile-views button')){if(!button.querySelector('svg[aria-hidden="true"]')||!button.textContent.trim())throw Error('Workspace action needs icon and text');}
      const textarea=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,'Keep this unsent draft');textarea.dispatchEvent(new Event('input',{bubbles:true}));await sleep(20);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(innerWidth>=900){const swap=document.querySelector('.workspace-swap').getBoundingClientRect(),share=document.querySelector('.workspace-share-link').getBoundingClientRect();if(share.left<swap.right||share.left-swap.right>24)throw Error('Swap and Share must be adjacent in that order');}
      const composer=document.querySelector('.composer-controls').getBoundingClientRect();for(const control of document.querySelectorAll('.composer-controls .choice-trigger,.composer-controls [aria-label="Send prompt"]')){const rect=control.getBoundingClientRect();if(rect.left<composer.left||rect.right>composer.right+1)throw Error('Composer control overflow '+scenario+' '+JSON.stringify({left:rect.left,right:rect.right,containerLeft:composer.left,containerRight:composer.right}));}
      if(composer.width<420){const options=document.querySelector('[aria-label="Prompt options"]');if(!options)throw Error('Narrow composer needs prompt options');options.click();await until(()=>document.querySelector('.composer-options-popup'),'prompt options open');if(!document.querySelector('[aria-label="Model"]')||!document.querySelector('[aria-label="Plan mode"]'))throw Error('Missing compact choices');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>options.getAttribute('aria-expanded')==='false','prompt options close');if(textarea.value!=='Keep this unsent draft')throw Error('Options lost draft');}
      if(scenario.includes('database')){
        const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent.trim()===text);
        await until(()=>button('No database'),'stateless default');button('No database').click();
        await until(()=>Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent.trim()==='Development database'),'Development choice');
        Array.from(document.querySelectorAll('[role=menuitem]')).find(node=>node.textContent.trim()==='Development database').click();
        await until(()=>button('Development database'),'selected Development');
        const navigation=innerWidth<900?'.workspace-mobile-views button':'.workspace-artifact-tabs button';
        Array.from(document.querySelectorAll(navigation)).find(node=>node.textContent.trim().startsWith('Database')).click();
        await until(()=>document.querySelector('.project-database')?.textContent.includes('Ready'),'confirmed Database pane');
        if(!button('Manage resource'))throw Error('Owner resource controls missing');
        if(getComputedStyle(document.querySelector('.database-artifact-pane')).overflowY!=='auto')throw Error('Database pane needs independent scrolling');
        if(document.documentElement.scrollWidth>innerWidth)throw Error('Database pane overflow');
        if(textarea.value!=='Keep this unsent draft')throw Error('Database navigation lost the draft');
        await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});return;
      }
      if(scenario.includes('revise')){
        const button=text=>Array.from(document.querySelectorAll('button')).find(node=>node.textContent===text);
        if(scenario.includes('other')){if(button('Edit and resubmit'))throw Error('Another author prompt is editable');}
        else{
          await until(()=>button('Edit and resubmit'),'own prompt action');button('Edit and resubmit').click();await until(()=>button('Keep my draft'),'replace review');button('Keep my draft').click();await until(()=>!document.querySelector('[role=dialog]')||document.querySelector('[role=dialog]').hasAttribute('data-closed'),'replacement dialog closed');if(textarea.value!=='Keep this unsent draft')throw Error('Cancel discarded unsent text');
          button('Edit and resubmit').click();await until(()=>document.querySelector('[role=dialog][data-open]')&&button('Replace draft'),'replace review again');button('Replace draft').click();await until(()=>textarea.value==='Make the introduction quieter, with an olive accent.','loaded prompt');
          if(!document.querySelector('.composer-revision-note').textContent.includes(${JSON.stringify(build.slice(0, 8))}))throw Error('Missing current revision context');
          if(document.querySelectorAll('.workspace-user-brief').length!==1)throw Error('Historical prompt changed');
          textarea.focus();textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await until(()=>textarea.value==='','explicit Send');
        }
        const activity=document.querySelector('.execution-activity');activity.open=true;await until(()=>activity.querySelectorAll('li').length===3,'saved execution activity');if(!activity.textContent.includes('Attempt 2')||!activity.textContent.includes('Failed')||!activity.textContent.includes('Unconfirmed'))throw Error('Attempt outcomes collapsed');
        await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});return;
      }
      if(scenario.includes('preview-')){if(innerWidth<900)Array.from(document.querySelectorAll('[aria-label="Workspace views"] button')).find(node=>node.textContent==='Preview').click();if(scenario.includes('ready')){await until(()=>document.querySelector('iframe'),'ready preview');const frame=document.querySelector('iframe');const add=document.querySelector('[aria-label="Prompt options"]');add.click();await until(()=>add.getAttribute('aria-expanded')==='true','project Add opens');const menu=document.querySelector('.composer-options-popup');if(!menu.textContent.includes('Project Skills')||!menu.textContent.includes('Media Permissions'))throw Error('Project tools missing from Add');const media=menu.querySelector('.workspace-preview-media');media.open=true;await until(()=>media.querySelector('input[type=url]'),'custom media input');if(document.querySelector('.workspace-preview-toolbar [aria-label="Preview media permissions"]'))throw Error('Media control still crowds preview toolbar');add.click();await until(()=>add.getAttribute('aria-expanded')==='false','project Add closes');if(scenario.includes('published')){await until(()=>!document.querySelector('.workspace-publish-action'),'already published action removed');if(!document.querySelector('.workspace-preview-actions a[href="https://published.fixture.test/"]'))throw Error('Published app action missing');}else{const devices=document.querySelector('[aria-label="Preview viewport"]'),publish=document.querySelector('.workspace-publish-action');if(!devices||!publish||devices.parentElement!==publish.closest(".workspace-preview-toolbar")||Math.abs(devices.getBoundingClientRect().top-publish.getBoundingClientRect().top)>8)throw Error('Preview actions are not on one row');}if(scenario.includes('publishing-interrupted')){await until(()=>document.querySelector('[aria-label="Preview details"]').textContent.includes('Needs attention'),'publishing attention');document.querySelector('[aria-label="Preview details"]').click();await until(()=>document.querySelector('.preview-details-popup[data-open]'),'preview details');const attention=document.querySelector('.workspace-preview-attention');if(!document.querySelector('.workspace-preview-toolbar [aria-label="Preview details"]'))throw Error('Details outside toolbar');if(!attention.querySelector('[role=alert]'))throw Error('Recovery detail unavailable');}if(frame.getAttribute('sandbox')!=='allow-scripts allow-forms allow-same-origin'||frame.getAttribute('referrerpolicy')!=='no-referrer')throw Error('Preview isolation attributes changed');document.querySelector('[aria-label="Mobile preview"]').click();await until(()=>frame.style.width==='390px','mobile viewport');document.querySelector('[aria-label="Tablet preview"]').click();await until(()=>frame.style.width==='768px','tablet viewport');document.querySelector('[aria-label="Desktop preview"]').click();await until(()=>frame.style.width==='100%','desktop viewport');if(frame!==document.querySelector('iframe'))throw Error('Viewport change replaced authorized frame');if(!document.querySelector('.workspace-preview-bar').textContent.includes('ready'))throw Error('Missing ready state');}else{await until(()=>document.querySelector('.workspace-preview-empty h2')?.textContent.includes(scenario.includes('interrupted')?'interrupted':scenario.includes('stopped')?'stopped':'preparing'),'preview state');if(document.querySelector('iframe'))throw Error('Unavailable preview framed an app');}if(document.querySelector('.workspace-preview-surface .workspace-preview-attention,.workspace-preview-surface .workspace-preview-media'))throw Error('Notices still push preview canvas');if(scenario.includes('stopped')){if(!document.querySelector('.workspace-preview-empty').textContent.includes('Prepare this revision again'))throw Error('Stopped preview recovery missing from canvas');if(!Array.from(document.querySelectorAll('.workspace-preview-surface > details')).some(node=>node.textContent.includes('Preview preparation and runtime logs')))throw Error('Runtime logs missing below preview');}if(textarea.value!=='Keep this unsent draft')throw Error('Preview view lost draft');await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});return;}
      if(scenario.includes('conversation')){await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});return;}
      const mobile=document.querySelector('[aria-label="Workspace views"]');
      if(innerWidth<900){Array.from(mobile.querySelectorAll('button')).find(node=>node.textContent==='Code').click();await until(()=>getComputedStyle(document.querySelector('.workspace-chat')).display==='none','mobile code');Array.from(mobile.querySelectorAll('button')).find(node=>node.textContent==='Conversation').click();await until(()=>getComputedStyle(document.querySelector('.workspace-chat')).display!=='none','mobile conversation');Array.from(document.querySelectorAll('[data-build-activity] button')).find(node=>node.textContent==='View revision').click();await until(()=>document.querySelector('.workspace-split').dataset.mobileView==='code','view revision opens artifacts');Array.from(mobile.querySelectorAll('button')).find(node=>node.textContent==='Conversation').click();}
      else{const separator=document.querySelector('[role=separator]'),previous=Number(separator.getAttribute('aria-valuenow'));separator.focus();separator.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));await until(()=>Number(separator.getAttribute('aria-valuenow'))>previous,'keyboard resize');document.querySelector('[aria-label="Swap conversation and artifact sides"]').click();if(document.querySelector('textarea')!==textarea)throw Error('Swap remounted composer');}
      if(textarea.value!=='Keep this unsent draft')throw Error('View switch lost draft');
      if(!document.querySelector('.workspace-user-brief .workspace-user-label')||!document.querySelector('.workspace-user-avatar'))throw Error('Missing inset sender or avatar');
      const history=document.querySelector('[aria-label="Revision history"]');if(!history||!history.textContent.includes('Revision 01'))throw Error('Selected revision missing from trigger');history.click();await until(()=>document.querySelector('[data-slot="dropdown-menu-content"]'),'history menu');const popup=document.querySelector('[data-slot="dropdown-menu-content"]');if(getComputedStyle(popup).backgroundColor==='rgba(0, 0, 0, 0)')throw Error('Transparent revision menu');if(!popup.textContent.includes('Selected'))throw Error('History selection missing');await until(()=>popup.contains(document.activeElement),'history focus');document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await until(()=>history.getAttribute('aria-expanded')==='false','history closes');
      if(innerWidth<900)Array.from(mobile.querySelectorAll('button')).find(node=>node.textContent==='Code').click();
      document.querySelector('[role=tab][id$="-code"]').click();await until(()=>document.querySelector('.workspace-file-paths button'),'files');const folder=document.querySelector('.workspace-file-paths summary');if(!folder||folder.textContent!=='app')throw Error('Missing folders-first browser');folder.focus();if(document.activeElement!==folder)throw Error('Folder cannot receive keyboard focus');folder.click();if(folder.parentElement.open)throw Error('Folder did not collapse');folder.click();if(!folder.parentElement.open)throw Error('Folder did not expand');Array.from(document.querySelectorAll('.workspace-file-paths button')).find(node=>node.getAttribute('title')==='app/globals.css').click();await until(()=>document.querySelector('.workspace-source-content pre').textContent.includes('olive'),'selected source');
      const fileSearch=document.querySelector('[aria-label="Search generated files"]');const find=value=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(fileSearch,value);fileSearch.dispatchEvent(new Event('input',{bubbles:true}))};find('absent');await until(()=>document.querySelector('.workspace-file-paths').textContent.includes('No matching files'),'file search empty');if(!document.querySelector('.workspace-source-content pre').textContent.includes('olive'))throw Error('Search lost source');find('globals');await until(()=>document.querySelectorAll('.workspace-file-paths button').length===1,'file search');find('');await until(()=>document.querySelectorAll('.workspace-file-paths button').length===2,'clear file search');
      if(scenario==='workspace-desktop'){await fetch('/change');await client.invalidateQueries({queryKey:['project',${JSON.stringify(project)}]});await until(()=>document.body.textContent.includes('Fixture validation failed'),'phase update');if(document.querySelector('[role=tab][aria-selected=true]').textContent.trim().startsWith('Logs'))throw Error('Phase stole explicit tab');if(!document.querySelector('.workspace-source-content pre').textContent.includes('olive'))throw Error('File order changed selection');}
      if(innerWidth<900)Array.from(mobile.querySelectorAll('button')).find(node=>node.textContent==='Code').click();
      if(scenario==='workspace-history')history.click();
      await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({ok:true})});}catch(error){await fetch('/report?case='+scenario,{method:'POST',body:JSON.stringify({error:error.message})})}})();`,
      );
      const output = join(directory, "fixture.js");
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
          "--define",
          "process.env.NEXT_PUBLIC_WEB_URL=" +
            JSON.stringify(server.url.origin),
          "--tsconfig-override",
          config,
          "--outdir",
          directory,
          "--entry-naming",
          "[name].[ext]",
        ],
        { cwd: web, stdout: "ignore", stderr: "pipe" },
      );
      const [code, diagnostic] = await Promise.all([
        built.exited,
        new Response(built.stderr).text(),
      ]);
      if (code) throw new Error(diagnostic);
      bundle = await readFile(output, "utf8");
      for (const [name, width] of [
        ["workspace-preview-ready", 1440],
        ["workspace-preview-ready-published", 1440],
        ["workspace-preview-ready-publishing-interrupted", 1440],
        ["workspace-preview-ready-phone", 390],
        ["workspace-preview-ready-dark", 1440],
        ["workspace-preview-interrupted", 1440],
        ["workspace-preview-preparing", 390],
        ["workspace-preview-stopped", 1440],
        ["workspace-revise", 1440],
        ["workspace-revise-other", 1440],
        ["workspace-desktop", 1440],
        ["workspace-mobile", 390],
        ["workspace-small", 320],
        ["workspace-tablet", 768],
        ["workspace-dark", 1440],
        ["workspace-history", 1440],
        ["workspace-conversation", 1440],
        ["workspace-phone-conversation", 390],
        ["workspace-database", 1440],
        ["workspace-database-phone", 390],
      ] as const) {
        databasesEnabled = name.includes("database");
        changed = false;
        messageOwner = name.includes("revise-other")
          ? "other-user"
          : "fixture-owner";
        publishingMode = name.includes("publishing-interrupted")
          ? "interrupted"
          : name.includes("published")
            ? "success"
            : "none";
        previewMode = name.includes("preview-stopped")
          ? "stopped"
          : name.includes("preview-ready")
            ? "ready"
            : name.includes("preview-interrupted")
              ? "interrupted"
              : name.includes("preview-preparing")
                ? "preparing"
                : "disabled";
        chrome = Bun.spawn(
          [
            process.env.WRENLY_TEST_CHROME_PATH ?? "/usr/bin/google-chrome",
            "--headless=new",
            "--disable-gpu",
            "--disable-background-networking",
            "--no-first-run",
            "--hide-scrollbars",
            "--virtual-time-budget=7000",
            `--user-data-dir=${join(directory, name)}`,
            `--window-size=${width},1000`,
            `--screenshot=${join(captures, name + ".png")}`,
            `${server.url.origin}/p/${project}?build=${build}&case=${name}`,
          ],
          { stdout: "ignore", stderr: "pipe" },
        );
        const [, browserDiagnostic] = await Promise.all([
          chrome.exited,
          typeof chrome.stderr === "number"
            ? Promise.resolve("Browser stderr pipe unavailable")
            : new Response(chrome.stderr).text(),
        ]);
        chrome = undefined;
        if (!reports.has(name))
          throw new Error(
            `Missing browser report for ${name}: ${browserDiagnostic}`,
          );
        expect(reports.get(name)?.error).toBeUndefined();
        expect(reports.get(name)?.ok).toBe(true);
      }
      expect(admissions).toBe(0);
      expect(promptRequests).toHaveLength(1);
      expect(promptRequests[0]?.baseBuildId).toBe(build);
      expect(promptRequests[0]?.message).toBe(
        "Make the introduction quieter, with an olive accent.",
      );
    } finally {
      chrome?.kill();
      await chrome?.exited;
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  }, 120000);
});
